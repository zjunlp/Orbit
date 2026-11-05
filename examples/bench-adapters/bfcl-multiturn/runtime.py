"""Container-only BFCL conversation driver and independent upstream verifier."""

import ast
import importlib.metadata
import inspect
import json
import os
from pathlib import Path
import sys
import uuid

from adapter import VERSION, held_tools


class RuntimeFailure(Exception):
    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind


class ActionError(ValueError):
    """An invalid subject action, not an unavailable environment."""


def jsonable(value):
    return json.loads(json.dumps(value, default=str, ensure_ascii=False, allow_nan=False))


def write_json(path, value):
    path.write_text(json.dumps(value, default=str, ensure_ascii=False, allow_nan=False, indent=2))


def upstream():
    try:
        if importlib.metadata.version("bfcl-eval") != VERSION:
            raise ValueError("Wrong bfcl-eval version")
        from bfcl_eval.eval_checker.multi_turn_eval.multi_turn_checker import (
            multi_turn_checker, multi_turn_irrelevance_checker,
        )
        from bfcl_eval.eval_checker.multi_turn_eval.multi_turn_utils import execute_multi_turn_func_call
        return execute_multi_turn_func_call, multi_turn_checker, multi_turn_irrelevance_checker
    except Exception as exc:
        raise RuntimeFailure("env_start", f"Cannot load pinned BFCL: {exc}") from exc


def parse_call(source, tools):
    """Never pass subject-supplied Python expressions to upstream eval."""
    try:
        node = ast.parse(source, mode="eval").body
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
            raise ValueError("Expected a named tool call")
        name = node.func.id
        if name not in tools or name.startswith("_"):
            raise ValueError(f"Tool is unavailable: {name}")
        if any(k.arg is None for k in node.keywords):
            raise ValueError("Expanded keyword arguments are not supported")
        args = [ast.literal_eval(a) for a in node.args]
        kwargs = {k.arg: ast.literal_eval(k.value) for k in node.keywords}
        if len(kwargs) != len(node.keywords):
            raise ValueError("Duplicate keyword argument")
        # Reconstruct from literals: no attributes, nested calls, imports or code execution.
        canonical = name + "(" + ", ".join(
            [repr(a) for a in args] + [f"{k}={v!r}" for k, v in kwargs.items()]
        ) + ")"
        return name, args, kwargs, canonical
    except (SyntaxError, ValueError, TypeError) as exc:
        raise ActionError(str(exc)) from exc


def toolset(payload, turn):
    held = held_tools(payload["entry"], turn)
    return {doc["name"]: doc for docs in payload["tools"].values() for doc in docs
            if doc["name"] not in held}


def state(instances):
    return jsonable({name: {k: v for k, v in vars(obj).items() if not k.startswith("_")}
                     for name, obj in instances.items()})


def check_arguments(method, args, kwargs, schema):
    try:
        bound = inspect.signature(method).bind(*args, **kwargs)
    except TypeError as exc:
        raise ActionError(str(exc)) from exc
    types = {"string": str, "integer": int, "int": int, "float": (int, float),
             "number": (int, float), "boolean": bool, "bool": bool,
             "dict": dict, "object": dict, "list": list, "array": list, "tuple": tuple}
    for key, value in bound.arguments.items():
        expected = schema["parameters"]["properties"].get(key, {}).get("type")
        cls = types.get(expected) if isinstance(expected, str) else None
        if cls is not None and value is not None and not isinstance(value, cls):
            return True
    return False


def call_tool(method, args, kwargs, schema_mismatch):
    # Call the upstream method directly so its executor cannot erase exception types. Match the
    # executor's result encoding; the unmodified checker still uses its own executor to score.
    try:
        result = method(*args, **kwargs)
    except (TypeError, ValueError) as exc:
        domain_errors = (
            "No available route for the given airports.",
            "Invalid travel class. Options are: economy, business, first.",
            "No available exchange rate for the given currencies.",
        )
        if not schema_mismatch and str(exc) not in domain_errors:
            raise RuntimeFailure("env_step", f"Unexpected BFCL tool error: {exc}") from exc
        return f"Error during execution: {exc}"
    except Exception as exc:
        raise RuntimeFailure("env_step", f"BFCL tool execution: {exc}") from exc
    if type(result) is str:
        return result
    if type(result) is dict:
        try:
            return json.dumps(result)
        except (TypeError, ValueError):
            return str(result)
    return str(result)


def replay(payload, turns, execute):
    entry = payload["entry"]
    namespace = "orbit_" + uuid.uuid4().hex
    kwargs = {"initial_config": entry["initial_config"], "involved_classes": entry["involved_classes"],
              "model_name": namespace, "test_entry_id": entry["id"],
              "long_context": "long_context" in entry["id"], "is_evaL_run": True}
    try:
        _, instances = execute([], **kwargs)
    except Exception as exc:
        raise RuntimeFailure("reset_failed", f"BFCL reset: {exc}") from exc
    methods = {name: method for obj in instances.values()
               for name, method in inspect.getmembers(obj, predicate=inspect.ismethod)
               if not name.startswith("_")}
    trace = {"task": entry["id"], "seed": payload["seed"], "version": VERSION,
             "digests": payload["digests"], "producer": "adapter-driver",
             "trust": "self-reported; independently replayed in verify",
             "tools": payload["tools"], "initial_state": state(instances), "turns": []}
    decoded = []
    for index, calls in enumerate(turns):
        available = toolset(payload, index)
        row = {"turn": index, "messages": entry["question"][index],
               "available_tools": list(available), "state_before": state(instances),
               "calls": [], "final_response": ""}
        executed = []
        for offset, source in enumerate(calls):
            call = {"id": f"turn-{index}-call-{offset}", "source": source}
            try:
                name, args, kw, canonical = parse_call(source, available)
                call.update({"name": name, "args": jsonable(args), "kwargs": jsonable(kw)})
                schema_mismatch = check_arguments(methods[name], args, kw, available[name])
            except ActionError as exc:
                call.update({"action_error": str(exc), "result": None})
                row["calls"].append(call)
                continue
            result = call_tool(methods[name], args, kw, schema_mismatch)
            call.update({"decoded": canonical, "result": result})
            row["calls"].append(call)
            executed.append(canonical)
        row["state_after"] = state(instances)
        trace["turns"].append(row)
        decoded.append([executed])
    return trace, decoded


def check(payload, decoded, checker):
    try:
        result = checker(decoded, payload["ground_truth"], payload["entry"],
                         payload["entry"]["id"].rsplit("_", 1)[0], "orbit_" + uuid.uuid4().hex)
        if not isinstance(result, dict) or type(result.get("valid")) is not bool:
            raise ValueError("Malformed BFCL checker reply")
        return result
    except Exception as exc:
        raise RuntimeFailure("scorer_error", f"Upstream multi_turn_checker: {exc}") from exc


def evidence_calls(payload, evidence):
    if any(evidence.get(k) != payload[k] for k in ("seed", "version", "digests")) or evidence.get("task") != payload["entry"]["id"]:
        raise RuntimeFailure("scorer_error", "Saved evidence identity mismatch")
    turns = evidence.get("turns")
    if not isinstance(turns, list) or len(turns) != len(payload["entry"]["question"]):
        raise RuntimeFailure("scorer_error", "Malformed saved conversation")
    result = []
    for index, turn in enumerate(turns):
        if turn.get("turn") != index or not isinstance(turn.get("calls"), list):
            raise RuntimeFailure("scorer_error", "Malformed saved turn")
        calls = [c["source"] for c in turn["calls"]]
        if len(calls) > 1000 or any(not isinstance(c, str) or len(c) > 65536 for c in calls):
            raise RuntimeFailure("scorer_error", "Saved calls exceed the evidence format limits")
        result.append(calls)
    return result


def first_failed_turn(payload, decoded, checker):
    """The checker returns at the first failing turn; find it by checking growing prefixes."""
    truth = payload["ground_truth"]
    for k in range(1, len(truth) + 1):
        if not check({**payload, "ground_truth": truth[:k]}, decoded, checker)["valid"]:
            return k - 1
    return None


def call_event(call):
    error = call.get("action_error")
    result = call.get("result")
    failed = isinstance(result, str) and result.startswith("Error during execution")
    arguments = {**{f"#{i}": v for i, v in enumerate(call.get("args", []))}, **call.get("kwargs", {})}
    event = {"type": "tool_call", "id": call["id"], "actor": "agent",
             "name": call.get("name") or call["source"].split("(", 1)[0].strip() or "?",
             "arguments": arguments, "source": call["source"],
             "status": "rejected" if error else "error" if failed else "ok"}
    if error:
        event["error"] = error
    else:
        event["result"] = result
        if failed:
            event["error"] = result
    return event


EXPLAIN = {
    "multi_turn:empty_turn_model_response":
        "The agent made no function call in a turn whose reference makes calls. Text replies are not graded.",
    "multi_turn:execution_response_mismatch":
        "Results that the reference calls of this turn return are missing from all results the agent "
        "obtained so far (order and earlier turns do not matter). See missing_items.",
    "multi_turn:instance_state_mismatch":
        "After this turn the environment state differs from the reference's. See differences.",
}


def conversation(payload, trace, truth_trace, result, failed_turn, method, saved=None):
    """The verifier's replay as a review conversation (Orbit `ConversationTrajectory`)."""
    entry = payload["entry"]
    passed = result["valid"]
    details = {k: v for k, v in (result.get("details") or {}).items() if k != "execution_result"}
    turns, tools = [], None
    for index, row in enumerate(trace["turns"]):
        events = [{"type": "message", "actor": m.get("role", "user"), "text": str(m.get("content", ""))}
                  for m in row["messages"]]
        events += [call_event(c) for c in row["calls"]]
        said = saved["turns"][index] if saved and index < len(saved.get("turns") or []) else {}
        if isinstance(said, dict) and said.get("final_response"):
            events.append({"type": "message", "actor": "agent", "text": str(said["final_response"])})
        if passed or failed_turn is None or index < failed_turn:
            check = {"status": "passed"}
        elif index == failed_turn:
            check = {"status": "failed", "detail": result.get("error_message", "")}
        else:
            check = {"status": "unchecked",
                     "detail": "The checker stops at the first failing turn"}
        turn = {"index": index, "events": events, "check": check,
                "state": {"before": row["state_before"], "after": row["state_after"],
                          "expected": truth_trace["turns"][index]["state_after"]},
                "reference": payload["ground_truth"][index]}
        added = sorted(set(row["available_tools"]) - set(tools)) if tools is not None else []
        if not row["messages"]:
            turn["note"] = "Tool update turn (no user message)" + (f": {', '.join(added)} available" if added else "")
        elif added:
            turn["note"] = "Newly available tools: " + ", ".join(added)
        if isinstance(said, dict) and said.get("reached") is False:
            turn["note"] = "The agent never reached this turn"
        tools = row["available_tools"]
        turns.append(turn)
    return {
        "version": 1, "kind": "conversation",
        "goal": str(entry["question"][0][0]["content"]) if entry["question"] and entry["question"][0] else "",
        "participants": [{"id": "user", "role": "user", "label": "User (dataset turns)"},
                         {"id": "agent", "role": "agent", "label": method},
                         {"id": "environment", "role": "environment",
                          "label": ", ".join(entry["involved_classes"])}],
        "turns": turns,
        "verdict": {"passed": passed, **({} if passed else {"type": result.get("error_type", ""),
                                                                "message": result.get("error_message", "")}),
                    "failedTurn": failed_turn, "details": details,
                    **({"explanation": EXPLAIN[result.get("error_type")]} if result.get("error_type") in EXPLAIN else {}),
                    "scorer": f"bfcl-eval {VERSION} multi_turn_checker"},
        "completeness": "complete", "producer": "verifier", "trust": "trusted",
    }


def verify_payload(payload, saved, output, api=None, method="method"):
    if payload.get("solve_failed"):
        raise RuntimeFailure("env_step", "The fixed BFCL solve driver failed; missing evidence is not a method's zero")
    execute, checker, irrelevant = api or upstream()
    truth_trace, truth_decoded = replay(payload, payload["ground_truth"], execute)
    if any(c.get("action_error") for t in truth_trace["turns"] for c in t["calls"]):
        raise RuntimeFailure("scorer_error", "Pinned ground truth cannot be executed by this scaffold")
    if not check(payload, truth_decoded, checker)["valid"]:
        raise RuntimeFailure("scorer_error", "Pinned ground truth failed upstream self-check")
    calls = evidence_calls(payload, saved) if saved is not None else [[] for _ in payload["entry"]["question"]]
    trace, decoded = replay(payload, calls, execute)
    trace.update({"producer": "verifier", "trust": "independent replay; solve states/results ignored"})
    write_json(output / "replay.json", trace)
    result = check(payload, decoded, checker)
    failed_turn = None if result["valid"] else first_failed_turn(payload, decoded, checker)
    write_json(output / "conversation.json",
               conversation(payload, trace, truth_trace, result, failed_turn, method, saved))
    return {"checker": result, "failed_turn": failed_turn, "irrelevance_diagnostic": irrelevant(decoded, payload["ground_truth"]),
            "calls": sum(len(t) for t in calls), "reference_self_check": True}


def run(phase, method, payload, output, saved_path=None, api=None):
    identity = {"task": payload["entry"]["id"], "seed": payload["seed"], "version": VERSION}
    try:
        if phase == "solve":
            execute, _, _ = api or upstream()
            turns = payload["ground_truth"] if method == "oracle" else [[] for _ in payload["entry"]["question"]]
            trace, _ = replay(payload, turns, execute)
            write_json(output / "evidence.json", trace)
        else:
            saved = json.loads(saved_path.read_text()) if saved_path and saved_path.exists() else None
            result = verify_payload(payload, saved, output, api, method)
            write_json(output / "verdict.json", {**identity, **result})
        return 0
    except Exception as exc:
        kind = exc.kind if isinstance(exc, RuntimeFailure) else "scorer_error"
        write_json(output / ("verdict.json" if phase == "verify" else "failure.json"),
                   {**identity, "failure": kind, "issue": str(exc)})
        print(f"{kind}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    payload = json.loads(Path("/input.json").read_text())
    sys.exit(run(sys.argv[1], sys.argv[2], payload, Path(os.environ["ORBIT_OUTPUT"]),
                 Path("/solve/evidence.json")))
