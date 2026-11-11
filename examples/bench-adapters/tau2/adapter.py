#!/usr/bin/env -S python3 -B
"""Direct tau2 text-session calibration; host protocol uses only the standard library."""

import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time

SDK = (Path("/sdk") if Path("/sdk/orbit_bench").is_dir()
       else Path(__file__).resolve().parents[2] / "sdk")
sys.path.insert(0, str(SDK))
from orbit_bench import invalid, main, valid  # noqa: E402

HERE = Path(__file__).resolve().parent
UPSTREAM = "https://github.com/sierra-research/tau2-bench"
COMMIT = "f8de30c298689cbe0117d76a378e7315a17e5bd8"
SOURCE_SHA256 = "edf2265d22186dca4b7ae9b705c3cc3927a9ff80f9b698a88d0daa701ecb7907"
IMAGE = "orbit-sample-tau2:v0.2.0"
USER_MODEL = "gpt-4.1-2025-04-14"
DOMAINS = ("airline", "retail")
DATA_SHA256 = {
    "data/tau2/domains/airline/tasks.json": "40d692b3fca780f46b56d48b447fd8db79a653f216667b8ed7c1a88380544532",
    "data/tau2/domains/airline/db.json": "1af9fea6e03ca7ca15a22bb3fcaf3e351393e3fc9070b6777947da8996f7531b",
    "data/tau2/domains/airline/policy.md": "10dc0525421521208be39cee235bba84a16e2bcba9899eb93d92cd81d2f62fc4",
    "data/tau2/domains/retail/tasks.json": "76e1fa649a359bef2d2fd30eae834b99d261d84e2e5d364856f6632fdf778dfd",
    "data/tau2/domains/retail/db.json": "413a65160adbdb5fde0ffc0015c49b6d70250b10c18128de169b597af7766765",
    "data/tau2/domains/retail/policy.md": "2c9652afbce57d6e087768d37cda64d31c53d50b3e3225cfdb791bac66466467",
    "data/tau2/user_simulator/simulation_guidelines.md": "05f4f48e5beefcb527d81fdee6271ce0e997fa4721e8d3ae4db0e820fb0a9013",
}
DEFAULT_BASIS = ["DB", "COMMUNICATE"]  # EvaluationCriteria default at the pinned commit.


class InvalidTrial(Exception):
    def __init__(self, failure, message):
        super().__init__(message)
        self.failure = failure


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def file_digest(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Expected a regular file: {path}")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_checkout(root, git=False):
    if git:
        head = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
        if head != COMMIT:
            raise ValueError(f"Expected tau2 commit {COMMIT}, got {head}")
    files = {str(p.relative_to(root / "src")): file_digest(p)
             for p in sorted((root / "src").rglob("*"))
             if p.is_file() and "__pycache__" not in p.parts}
    if digest(files) != SOURCE_SHA256:
        raise ValueError("tau2 source tree SHA256 mismatch")
    for name, expected in DATA_SHA256.items():
        if file_digest(root / name) != expected:
            raise ValueError(f"tau2 data SHA256 mismatch: {name}")


def settings(req):
    cfg = req["benchmark"].get("config") or {}
    if set(cfg) - {"image"}:
        raise ValueError("Only config image is supported")
    root = Path(req["benchmark"]["path"]).resolve()
    validate_checkout(root, git=True)
    return root, cfg.get("image", IMAGE)


def task_data(root, task_id):
    domain, sep, native_id = task_id.partition(":")
    if domain not in DOMAINS or not sep:
        raise ValueError(f"Unknown task {task_id}")
    rows = json.loads((root / f"data/tau2/domains/{domain}/tasks.json").read_text())
    matches = [t for t in rows if str(t["id"]) == native_id]
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one task {task_id}")
    return domain, matches[0]


def unsupported(task):
    criteria = task.get("evaluation_criteria")
    if criteria is None:
        return "No upstream evaluation criteria"
    basis = set(criteria.get("reward_basis", DEFAULT_BASIS))
    if "NL_ASSERTION" in basis:
        return "Reward requires an LLM NL assertion judge; judge_unavailable (offline profile)"
    if not basis or basis - {"DB", "ACTION", "ENV_ASSERTION", "COMMUNICATE"}:
        return "Unsupported upstream reward basis"
    if any(a.get("requestor", "assistant") != "assistant" for a in criteria.get("actions") or []):
        return "User tool actions require dual-control; this sample is single-control"
    return None


def tasks(req):
    root, image = settings(req)
    rows = []
    for domain in DOMAINS:
        for task in json.loads((root / f"data/tau2/domains/{domain}/tasks.json").read_text()):
            reason = unsupported(task)
            rows.append({"id": f"{domain}:{task['id']}", "title": f"{domain} conversation {task['id']}",
                         "supported": reason is None, "reason": reason,
                         "tags": {"suite": domain, "oracle": "full", "taskSha256": digest(task)}})
    return {
        "tasks": rows,
        "capabilities": {
            "identity": {"id": "tau2-bench", "name": "τ²-bench", "version": COMMIT[:10]},
            "methods": ["oracle", "empty"],
            "scoreKind": "binary", "rescore": "score",
            "calibration": {"oracle": "max", "empty": "any", "repeat": "exact", "seedsVary": False},
            "conditions": {
                "Source": f"{UPSTREAM}/tree/{COMMIT} (v0.2.0)",
                "Source tree SHA256": SOURCE_SHA256,
                **{f"SHA256 {p.removeprefix('data/tau2/')}": sha for p, sha in DATA_SHA256.items()},
                "Image": image,
                "Subject": "One task conversation; agent is subject, user simulator is environment. Calibration methods only.",
                "User simulator model": f"{USER_MODEL}; temperature=0; dormant for oracle/empty; no model/API calls",
                "User simulator prompt": "tau2.user.user_simulator.SYSTEM_PROMPT + pinned simulation_guidelines.md + task.user_scenario; no user tools",
                "User simulator seed": "trial.seed (recorded, simulator is not invoked); deterministic gold replay / immediate agent_stop",
                "Scoring": "Pinned evaluate_simulation(ALL, solo_mode=False): DB, action, env assertions, deterministic substring communication; NL reward tasks rejected",
                "Calibration": "oracle=max; empty may get 1 when unchanged DB satisfies refusal/read-only tasks; exact repeat; no live-user claim",
                "Resources": "solve and verify each 1 CPU, 2 GiB RAM, 0 GPU, 5 min; dedicated in-memory DB, zero API quota",
                "Evidence": "Native SimulationRun + context/state/tool schemas + JSONL index + Markdown; trusted adapter produces, verifier replays",
            },
        },
        "metrics": [{"name": "success", "label": "Success", "unit": "%", "range": [0, 100],
                     "description": "Upstream binary reward multiplied by 100"}],
        "official": {"name": "tau2 average reward (offline subset)", "version": COMMIT,
                     "errors": "exclude", "unit": "task"},
    }


def plan_for(req, root):
    trial = req["trial"]
    domain, task = task_data(root, trial["task"])
    method = trial["method"]["agent"]
    if method not in ("oracle", "empty"):
        raise ValueError("Only oracle and empty are implemented; external/CLI methods are not supported")
    return {"version": 1, "trial": trial["id"], "task": trial["task"], "domain": domain,
            "taskSha256": digest(task), "method": method, "seed": trial["seed"],
            "commit": COMMIT, "sourceSha256": SOURCE_SHA256,
            "userSimulator": {"model": USER_MODEL, "temperature": 0, "seed": trial["seed"], "invoked": False}}


def run_spec(req, phase):
    root, image = settings(req)
    plan = plan_for(req, root)
    if phase == "solve":
        reason = unsupported(task_data(root, plan["task"])[1])
        if reason:
            raise ValueError(reason)
    staging = Path(req["trial"]["staging"]) / phase
    staging.mkdir(parents=True, exist_ok=True)
    (staging / "plan.json").write_text(json.dumps(plan))
    mounts = [{"source": str(root / "src"), "target": "/upstream/src", "mode": "ro"},
              {"source": str(HERE), "target": "/adapter", "mode": "ro"},
              {"source": str(SDK), "target": "/sdk", "mode": "ro"},
              {"source": str(staging), "target": "/plan", "mode": "ro"}]
    mounts.extend({"source": str(root / p), "target": f"/upstream/{p}", "mode": "ro"} for p in DATA_SHA256)
    if phase == "verify":
        mounts.append({"source": req["solve"]["output"], "target": "/solve", "mode": "ro"})
    return {"spec": {
        "image": image, "entrypoint": "python3",
        "command": ["/adapter/adapter.py", f"__{phase}", "/plan/plan.json"],
        "workdir": "/tmp", "mounts": mounts, "network": False,
        "resources": {"cpus": 1, "memGB": 2, "gpus": 0},
        "env": {"PYTHONPATH": "/sdk:/upstream/src", "TAU2_DATA_DIR": "/upstream/data",
                "PYTHONDONTWRITEBYTECODE": "1", "LITELLM_LOCAL_MODEL_COST_MAP": "True"},
        "timeoutMin": (req["trial"].get("timeoutMin") or 5) if phase == "solve" else 5,
    }}


def solve(req):
    return run_spec(req, "solve")


def verify(req):
    return run_spec(req, "verify")


def review():
    return {"files": [
        {"label": "Conversation", "phase": "verify", "kind": "conversation", "fallback": "json",
         "path": "conversation.json"},
        {"label": "Transcript", "phase": "solve", "kind": "markdown", "path": "trajectory.md"},
        {"label": "Native simulation", "phase": "solve", "kind": "json", "path": "simulation.json"},
        {"label": "Inputs and shared state", "phase": "solve", "kind": "json", "path": "context.json"},
        {"label": "Event index", "phase": "solve", "kind": "text", "path": "events.jsonl"},
        {"label": "Upstream reward", "phase": "verify", "kind": "json", "path": "reward.json"},
        {"label": "Verifier", "phase": "verify", "kind": "json", "path": "result.json"},
    ], "details": {"producer": "adapter harness / upstream environment; separate verifier",
                    "trust": "calibration harness; reward recomputed offline; no solve score is trusted",
                    "completeness": "complete calibration trajectory; no live user simulator",
                    "upstream": f"{UPSTREAM}/tree/{COMMIT}"}}


def score(req):
    try:
        root, _ = settings(req)
        result = json.loads((Path(req["verify"]["output"]) / "result.json").read_text())
        if result["plan"] != plan_for(req, root):
            raise ValueError("Verifier plan does not match trial")
        if result["invalid"]:
            return invalid(result["failure"], *result["issues"], review=review())
        if result["evidenceSha256"] != file_digest(Path(req["solve"]["output"]) / "simulation.json"):
            raise ValueError("Simulation changed after verification")
        value = result["score"]
        if type(value) not in (int, float) or not math.isfinite(value) or value not in (0, 1):
            raise ValueError("Upstream did not produce a binary reward")
        return valid(value, metrics={"success": 100 * value}, review=review(), episode=result["episode"])
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        return invalid("scorer_error", str(exc), review=review())


def load_runtime(root, plan):
    validate_checkout(root)
    domain, raw = task_data(root, plan["task"])
    if digest(raw) != plan["taskSha256"] or plan["commit"] != COMMIT or plan["sourceSha256"] != SOURCE_SHA256:
        raise InvalidTrial("scorer_error", "Pinned task/source identity changed")
    reason = unsupported(raw)
    if reason:
        basis = (raw.get("evaluation_criteria") or {}).get("reward_basis", [])
        raise InvalidTrial("judge_unavailable" if "NL_ASSERTION" in basis else "scorer_error", reason)
    from tau2.data_model.tasks import Task
    task = Task.model_validate(raw)
    constructor = importlib.import_module(f"tau2.domains.{domain}.environment").get_environment
    return task, constructor


def reset(constructor, task):
    try:
        env = constructor(solo_mode=False)
    except Exception as exc:
        raise InvalidTrial("env_start", f"Environment initialization failed: {exc}") from exc
    state = task.initial_state
    try:
        env.set_state(initialization_data=state.initialization_data if state else None,
                      initialization_actions=state.initialization_actions if state else None,
                      message_history=state.message_history or [] if state else [])
    except Exception as exc:
        raise InvalidTrial("reset_failed", f"Initial state replay failed: {exc}") from exc
    return env


def gold_messages(env, task, messages):
    from tau2.data_model.message import AssistantMessage, ToolCall
    for i, action in enumerate(task.evaluation_criteria.actions or []):
        call = ToolCall(id=f"gold_{i}", name=action.name, arguments=action.arguments, requestor=action.requestor)
        messages.append(AssistantMessage(role="assistant", tool_calls=[call]))
        response = env.get_response(call)
        messages.append(response)
        if response.error:
            raise InvalidTrial("env_step", f"Upstream gold action failed: {action.name}: {response.content}")
    for info in task.evaluation_criteria.communicate_info or []:
        messages.append(AssistantMessage(role="assistant", content=info))


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n")


def solve_runtime(root, plan, out):
    task, constructor = load_runtime(root, plan)
    from tau2.data_model.simulation import SimulationRun
    from tau2.user.user_simulator import UserSimulator
    from tau2.utils.utils import get_now
    env = reset(constructor, task)
    initial_db = env.tools.db.model_dump(mode="json")
    messages = list(task.initial_state.message_history or []) if task.initial_state else []
    start, clock = get_now(), time.monotonic()
    failure = None
    try:
        if plan["method"] == "oracle":
            gold_messages(env, task, messages)
        elif plan["method"] != "empty":
            raise ValueError("Unsupported method")
    except Exception as exc:
        failure = exc
    termination = "too_many_errors" if failure else "agent_stop"
    for i, message in enumerate(messages):
        message.turn_idx = i
    simulation = SimulationRun(id=plan["trial"], task_id=task.id, seed=plan["seed"],
                               start_time=start, end_time=get_now(), duration=time.monotonic() - clock,
                               termination_reason=termination, messages=messages,
                               agent_cost=0, user_cost=0)
    write_json(out / "simulation.json", {"plan": plan, "simulation": simulation.model_dump(mode="json"),
                                         "runtimeError": str(failure) if failure else None})
    # Constructing a UserSimulator only formats the upstream prompt; no generation method is called.
    user = UserSimulator(instructions=str(task.user_scenario), llm=USER_MODEL,
                         llm_args={"temperature": 0, "seed": plan["seed"]})
    write_json(out / "context.json", {"plan": plan, "environment": env.get_info(True).model_dump(mode="json"),
                                     "userScenario": task.user_scenario.model_dump(mode="json"),
                                     "userPrompt": user.system_prompt, "userInvoked": False,
                                     "initialState": task.initial_state.model_dump(mode="json") if task.initial_state else None,
                                     "initialDB": initial_db, "finalDB": env.tools.db.model_dump(mode="json")})
    lines, events = ["# tau2 calibration conversation", "", "No user LLM invoked; complete gold replay or immediate agent stop.", ""], []
    for i, message in enumerate(messages):
        raw = message.model_dump(mode="json")
        kind = "tool_result" if message.role == "tool" else "tool_call" if raw.get("tool_calls") else "message"
        events.append({"step": i, "type": kind, "producer": "environment" if message.role == "tool" else "calibration",
                       "trust": "trusted-harness", "native": f"simulation.json#/simulation/messages/{i}", "message": raw})
        lines.extend([f"## {i}: {message.role}", "", "```json", json.dumps(raw, ensure_ascii=False, indent=2), "```", ""])
    lines.append(f"Stop: {termination}")
    (out / "trajectory.md").write_text("\n".join(lines) + "\n")
    (out / "events.jsonl").write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in events))
    if failure:
        raise failure


def flatten(value, prefix="", out=None):
    """JSON value → {path: leaf}; lists by index, dicts by key."""
    out = {} if out is None else out
    if isinstance(value, dict) and value:
        for k, v in value.items():
            flatten(v, f"{prefix}.{k}" if prefix else str(k), out)
    elif isinstance(value, list) and value:
        for i, v in enumerate(value):
            flatten(v, f"{prefix}[{i}]", out)
    else:
        out[prefix] = value
    return out


def state_changes(initial, expected, actual, limit=500):
    """Paths where the expected or the actual final DB differs from the initial one, or each other."""
    a, b, c = flatten(initial), flatten(expected), flatten(actual)
    missing = object()
    rows = []
    for path in sorted(set(a) | set(b) | set(c)):
        x, y, z = a.get(path, missing), b.get(path, missing), c.get(path, missing)
        if x is y is z or (x == y == z):
            continue
        row = {"path": path}
        for key, v in (("initial", x), ("expected", y), ("actual", z)):
            if v is not missing:
                row[key] = v
        rows.append(row)
        if len(rows) >= limit:
            break
    return rows


def replay_db(constructor, task, messages):
    """The DB after replaying the conversation's tool calls on a fresh environment."""
    env = reset(constructor, task)
    for message in messages:
        for call in getattr(message, "tool_calls", None) or []:
            env.get_response(call)
    return env.tools.db.model_dump(mode="json")


def conversation_of(plan, task, simulation, reward, initial_db, expected_db, actual_db):
    """The verified conversation as an Orbit `ConversationTrajectory` (review kind `conversation`)."""
    results = {}
    for m in simulation.messages:
        if m.role == "tool":
            results[m.id] = m
    turns, events = [], []
    for m in simulation.messages:
        if m.role == "tool":
            continue
        actor = "agent" if m.role == "assistant" else "user" if m.role == "user" else "system"
        if actor == "user" and events:
            turns.append({"index": len(turns), "events": events})
            events = []
        if m.content:
            events.append({"type": "message", "actor": actor, "text": m.content})
        for call in m.tool_calls or []:
            r = results.get(call.id)
            caller = "user" if str(getattr(call.requestor, "value", call.requestor)) == "user" else "agent"
            event = {"type": "tool_call", "id": call.id or f"call-{len(events)}", "actor": caller,
                     "name": call.name, "arguments": call.arguments,
                     "status": "error" if r is not None and r.error else "ok"}
            if r is not None:
                event["result"] = r.content
                if r.error:
                    event["error"] = r.content
            events.append(event)
    if events or not turns:
        turns.append({"index": len(turns), "events": events})
    info = reward
    basis = [str(getattr(b, "value", b)) for b in info.reward_basis or []]
    checks = []
    if info.db_check is not None:
        checks.append({"name": "final database matches the reference", "scored": "DB" in basis,
                       "status": "passed" if info.db_check.db_match else "failed"})
    for c in info.communicate_checks or []:
        checks.append({"name": f"communicated: {c.info}", "status": "passed" if c.met else "failed",
                       "scored": "COMMUNICATE" in basis,
                       **({"detail": c.justification} if c.justification else {})})
    for c in info.action_checks or []:
        args = ", ".join(f"{k}={v!r}" for k, v in c.action.arguments.items())
        checks.append({"name": f"action {c.action.name}({args})", "scored": "ACTION" in basis,
                       "status": "passed" if c.action_match else "failed"})
    return {
        "version": 1, "kind": "conversation", "goal": str(task.user_scenario.instructions)[:100_000],
        "participants": [{"id": "agent", "role": "agent", "label": plan["method"]},
                         {"id": "user", "role": "user",
                          "label": "Simulated user" if plan["userSimulator"]["invoked"] else "User (not simulated)"},
                         {"id": "system", "role": "system", "label": "System"},
                         {"id": "environment", "role": "environment", "label": f"{plan['domain']} tools"}],
        "turns": turns,
        "verdict": {"passed": info.reward == 1, "message": f"reward {info.reward:g}; basis {', '.join(basis)}",
                    "failedTurn": None, "checks": checks,
                    "details": {"reward_breakdown": {str(getattr(k, "value", k)): v
                                                     for k, v in (info.reward_breakdown or {}).items()}},
                    "scorer": f"tau2 evaluate_simulation ({COMMIT[:10]})"},
        "finalState": state_changes(initial_db, expected_db, actual_db),
        "completeness": "complete" if plan["userSimulator"]["invoked"] else "environment-only",
        "producer": "verifier", "trust": "trusted",
    }


def verify_runtime(root, plan, source, out):
    try:
        task, constructor = load_runtime(root, plan)
        # The upstream environment evaluator logs and swallows gold-action exceptions. Fail closed
        # before calling it, including for empty trials, so broken gold infrastructure cannot score 0.
        gold_env = reset(constructor, task)
        initial_db = gold_env.tools.db.model_dump(mode="json")
        gold_messages(gold_env, task, [])
        expected_db = gold_env.tools.db.model_dump(mode="json")
        from loguru import logger
        from tau2.data_model.simulation import SimulationRun
        from tau2.evaluator.evaluator import EvaluationType, evaluate_simulation
        path = source / "simulation.json"
        evidence_hash = file_digest(path)
        evidence = json.loads(path.read_text())
        if evidence["plan"] != plan:
            raise ValueError("Saved evidence belongs to another trial")
        raw = {**evidence["simulation"], "reward_info": None}
        simulation = SimulationRun.model_validate(raw)
        if (simulation.id, simulation.task_id, simulation.seed) != (plan["trial"], task.id, plan["seed"]):
            raise ValueError("Native simulation identity mismatch")
        if simulation.termination_reason.value != "agent_stop":
            raise ValueError("Calibration trajectory did not end normally")
        warnings = []
        sink = logger.add(lambda m: warnings.append(str(m)), level="WARNING")
        try:
            reward = evaluate_simulation(simulation=simulation, task=task, evaluation_type=EvaluationType.ALL,
                                         solo_mode=False, domain=plan["domain"])
        finally:
            logger.remove(sink)
        if any("Error in golden actions" in w for w in warnings):
            raise InvalidTrial("scorer_error", "Upstream swallowed a gold-action failure")
        value = reward.reward
        if not math.isfinite(value) or value not in (0, 1):
            raise ValueError("Non-binary upstream reward")
        write_json(out / "reward.json", reward.model_dump(mode="json"))
        try:
            actual_db = replay_db(constructor, task, simulation.messages)
            write_json(out / "conversation.json", conversation_of(
                plan, task, simulation, reward, initial_db, expected_db, actual_db))
        except Exception as exc:  # The review view is derived evidence; it never changes the score.
            write_json(out / "conversation-error.json", {"error": f"{type(exc).__name__}: {exc}"})
        episode = {"steps": len(simulation.messages), "terminated": True, "truncated": False,
                   "endedBy": "agent", "successSignal": "tau2.evaluate_simulation:ALL"}
        result = {**valid(value, episode=episode), "evidenceSha256": evidence_hash}
    except InvalidTrial as exc:
        result = invalid(exc.failure, str(exc))
    except Exception as exc:
        result = invalid("scorer_error", f"{type(exc).__name__}: {exc}")
    write_json(out / "result.json", {**result, "plan": plan})
    return result


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] in ("__solve", "__verify"):
        plan = json.loads(Path(sys.argv[2]).read_text())
        out = Path(os.environ["ORBIT_OUTPUT"])
        out.mkdir(parents=True, exist_ok=True)
        if sys.argv[1] == "__solve":
            solve_runtime(Path("/upstream"), plan, out)
        else:
            verify_runtime(Path("/upstream"), plan, Path("/solve"), out)
    else:
        sys.exit(main(tasks, solve, verify, score))
