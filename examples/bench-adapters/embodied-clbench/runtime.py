"""Native environment transport, explicit reference calibration, and independent replay."""
import hashlib
from functools import wraps
import importlib.util
import json
import os
from pathlib import Path
import sys
import socket
import socketserver
import threading

def load_native():
    global dialogue, TongSimFrameworkRuntime, load_tongsim_task, native_mcp
    from tongbench_eval.cli.framework import dialogue
    from tongbench_eval.graph_env.runtime.framework_runtime import TongSimFrameworkRuntime
    from tongbench_eval.graph_env.io.loader import load_tongsim_task
    from tongbench_eval.mcp import server as native_mcp


def read(path):
    return json.loads(Path(path).read_text())


def write(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def jsonlines(path):
    if not Path(path).is_file():
        raise FileNotFoundError(f"Missing trusted event log: {path}")
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def check_inputs(plan):
    for relative, expected in plan["fingerprints"].items():
        path = Path("/data") / relative
        if path.resolve().is_relative_to(Path("/data").resolve()) is False:
            raise ValueError("Input fingerprint path escapes dataset")
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f"Frozen task data changed: {relative}")


def initialize(plan, runtime_root, evidence):
    check_inputs(plan)
    evidence.mkdir(parents=True, exist_ok=True)
    write(evidence / "plan.json", plan)
    (evidence / "events.jsonl").touch()
    runtime = TongSimFrameworkRuntime(runtime_root / "native")
    steps = dialogue._build_dialogue_steps_for_task_ids(
        item={}, results_root=Path("/data"), run_dir=runtime_root,
        task_ids=plan["task_ids"], l1_max_steps=100, l2_max_steps=100, l3_max_steps=100,
        l4_max_steps=100, l5_max_steps=100, l6_max_steps=100,
        max_steps_factor=0, max_steps_extra=plan["rollout_extra"], hide_decomposition=True)
    sessions = []
    for step in steps:
        session = runtime.create_session(
            task_dir=step.graph_path, output_dir=step.output_dir,
            action_interface="full_action", action_library_mode="atomic_only",
            atomic_template_path=Path("/upstream/For_user/templates/atomic_templates_updated_env_v3.json"),
            subtask_template_path=Path("/upstream/For_user/templates/subtask_templates_compressed_updated_env_v3.json"),
            exclusive_in_view=True, max_steps=step.max_steps, public_interface_mode="natural_language",
            public_workspace_dir=runtime_root / "workspaces" / step.workspace_name,
            unique_state_image_dir=step.unique_state_image_dir, generic_invalid_action_feedback=True,
            description_field="description_highlevel_hard", protocol_surface="safe_choice",
            choice_count=4, choice_seed=plan["seed"],
            choice_bank_path=Path("/data/option_bank_highlevel_v2_smoke.jsonl"), write_human_trace_md=True)
        dialogue._rewrite_session_config(Path(session.public_workspace_dir), session.bridge_dir)
        sessions.append({"session_id": session.session_id, "task_id": step.task_id,
                         "max_steps": step.max_steps, "index": len(sessions)})
    manifest = {"runtime_root": str(runtime.runtime_root), "sessions": sessions}
    write(evidence / "sessions.json", manifest)
    config_path = runtime_root / "mcp/.tongsim_sequence_session.json"
    config = {"sequence_steps": [{"index": row["index"], "session_id": row["session_id"]} for row in sessions],
              "sequence_state_path": str(runtime_root / "mcp/sequence-state.json"),
              "observation_subdir": "current_observation", "protocol_surface": "safe_choice"}
    write(config_path, config)
    native_mcp.SESSION_CONFIG_PATH = config_path
    return runtime, sessions, config


def ensure_images(result):
    observations = [result] if "choices" in result else []
    if isinstance(result.get("next_observation"), dict):
        observations.append(result["next_observation"])
    for observation in observations:
        if observation.get("done"):
            continue
        paths = observation.get("image_paths", [])
        if not paths or any(not Path(path).is_file() for path in paths):
            raise RuntimeError("Official visual observation is missing; text-only fallback is forbidden")


def dispatcher(runtime, sessions, evidence):
    lock = threading.Lock()

    def dispatch(step, command, payload=None, timeout_sec=120):
        del timeout_sec
        with lock:
            try:
                index = step["index"]
                if type(index) is not int or index < 0 or index >= len(sessions):
                    raise ValueError("Invalid sequence index")
                session_id = sessions[index]["session_id"]
                if command == "observe":
                    result = runtime.observe(session_id)
                elif command == "act":
                    result = runtime.act(session_id, payload or {})
                elif command == "status":
                    result = runtime.status(session_id)
                else:
                    raise ValueError(f"Unsupported native tool command: {command}")
                ensure_images(result)
                with (evidence / "events.jsonl").open("a") as handle:
                    handle.write(json.dumps({"index": index, "command": command, "payload": payload or {}, "result": result}) + "\n")
                return result
            except Exception as exc:
                write(evidence / "environment_error.json", {"error": f"{type(exc).__name__}: {exc}"})
                raise
    return dispatch


def export(evidence):
    manifest = read(evidence / "sessions.json")
    runtime = TongSimFrameworkRuntime(Path(manifest["runtime_root"]))
    episodes = []
    for row in manifest["sessions"]:
        destination = evidence / "episodes" / f"{row['index']:02d}_{row['task_id']}"
        runtime.export_outputs(row["session_id"], destination)
        episodes.append({**row, "score": read(destination / "score.json"),
            "grade": read(destination / "task_output/grade.json"),
            "trace": jsonlines(destination / "task_output/trace.jsonl") if (destination / "task_output/trace.jsonl").is_file() else []})
    write(evidence / "episodes.json", episodes)
    write(evidence / "finalized.json", {"complete": True})
    return episodes


def guarded_tool(function, gate, closing):
    @wraps(function)
    def wrapped(*args, **kwargs):
        with gate:
            if closing.is_set():
                raise RuntimeError("The environment is finalizing; no further actions are accepted")
            return function(*args, **kwargs)
    return wrapped


def drain_and_export(evidence, gate, closing):
    closing.set()
    with gate:
        if not (evidence / "finalized.json").is_file():
            export(evidence)


def serve(plan):
    evidence = Path("/evidence")
    runtime, sessions, config = initialize(plan, Path("/tmp/clbench-runtime"), evidence)
    native_mcp._send_sequence_request = dispatcher(runtime, sessions, evidence)
    os.environ["TONGSIM_MCP_IMAGE_CONTENT_ONLY"] = "1"
    os.environ["TONGSIM_MCP_CONTEXT_MODE"] = "full"
    server = native_mcp._build_server()
    gate = threading.Lock()
    closing = threading.Event()

    for tool in server._tool_manager._tools.values():
        tool.fn = guarded_tool(tool.fn, gate, closing)

    class FinalizeHandler(socketserver.StreamRequestHandler):
        def handle(self):
            if self.rfile.readline(100) != b"finalize\n":
                return
            try:
                drain_and_export(evidence, gate, closing)
                result = {"ok": True}
            except Exception as exc:
                result = {"ok": False, "error": str(exc)}
            self.wfile.write(json.dumps(result).encode() + b"\n")

    control = socketserver.ThreadingUnixStreamServer("/tmp/clbench-finalize.sock", FinalizeHandler)
    os.chmod("/tmp/clbench-finalize.sock", 0o600)
    threading.Thread(target=control.serve_forever, daemon=True).start()
    server.settings.host = "0.0.0.0"
    server.settings.port = 8765
    # Only this run's private network can reach the original MCP tools.
    server.settings.transport_security.enable_dns_rebinding_protection = False
    server.run(transport="streamable-http")


def finalize():
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(85)
        client.connect("/tmp/clbench-finalize.sock")
        client.sendall(b"finalize\n")
        response = b""
        while not response.endswith(b"\n"):
            chunk = client.recv(4096)
            if not chunk:
                raise RuntimeError("Native environment finalization disconnected")
            response += chunk
        result = json.loads(response)
        if not result.get("ok"):
            raise RuntimeError(result.get("error", "Native environment did not finalize"))


def calibrate(plan, method):
    evidence = Path(os.environ["ORBIT_OUTPUT"]) / "evidence"
    runtime, sessions, config = initialize(plan, Path("/tmp/clbench-runtime"), evidence)
    dispatch = dispatcher(runtime, sessions, evidence)
    if method == "oracle":
        for index, row in enumerate(sessions):
            step = config["sequence_steps"][index]
            dispatch(step, "observe")
            session = runtime.load_session(row["session_id"])
            task = load_tongsim_task(Path(session.task_dir), description_field=session.description_field)
            paths = task.success_traces or task.goal_paths
            reference = min((path for path in paths if isinstance(path, list) and path), key=len)
            for raw_action in reference:
                action = raw_action if isinstance(raw_action, str) else raw_action["action"]
                choices = runtime._read_runtime_meta(row["session_id"])["choice_observation"]["hidden_choices"]
                letter = next((label for label, choice in choices.items() if choice["action_id"] == action), None)
                if letter is None:
                    raise ValueError(f"Official option bank lacks reference action {action}")
                result = dispatch(step, "act", {"option_id": letter, "brief_reason": "Explicit reference calibration"})
                if result.get("done"):
                    break
            if not runtime._read_runtime_meta(row["session_id"]).get("last_reached_goal"):
                raise ValueError("Official reference path did not reach its goal")
    export(evidence)


def verify(plan):
    output = Path(os.environ["ORBIT_OUTPUT"])
    source = Path("/solve")
    try:
        if read(source / "plan.json") != plan:
            raise ValueError("Saved source/task/sequence/data fingerprints differ from verification plan")
        if (source / "environment_error.json").exists():
            raise ValueError(read(source / "environment_error.json")["error"])
        if read(source / "finalized.json") != {"complete": True}:
            raise ValueError("Trusted environment did not finalize")
        expected = read(source / "episodes.json")
        runtime, sessions, config = initialize(plan, Path("/tmp/clbench-replay"), output / "replay")
        dispatch = dispatcher(runtime, sessions, output / "replay")
        last_index = 0
        for event in jsonlines(source / "events.jsonl"):
            index = event["index"]
            if type(index) is not int or index < last_index or index > last_index + 1 or index >= len(sessions):
                raise ValueError("Actions violate the official learning-before-target order")
            if index > last_index:
                if not runtime.status(sessions[last_index]["session_id"]).get("done"):
                    raise ValueError("A learning episode was skipped before the next task")
                last_index = index
            dispatch(config["sequence_steps"][index], event["command"], event["payload"])
        replayed = export(output / "replay")
        if len(expected) != len(replayed):
            raise ValueError("Saved episode coverage differs from the official sequence")
        for saved, actual in zip(expected, replayed):
            if saved["task_id"] != actual["task_id"] or saved["grade"] != actual["grade"]:
                raise ValueError("Independent native replay disagrees with saved scoring")
        target = replayed[-1]
        if target["task_id"] != plan["target"]:
            raise ValueError("Final episode is not the requested target")
        native_path = Path("/upstream/For_user/scripts/summarize_l2_l4_results.py")
        spec = importlib.util.spec_from_file_location("native_report", native_path)
        report = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(report)
        row = report.row_from_scored_record(stage=plan["subset"], model="orbit", harness=plan["method"],
            setting=plan["mode"], task_id=plan["target"], record=target,
            summary_path=output / "result.json", max_steps_extra=plan["rollout_extra"])
        budget = report.budget_rows([row], plan["report_extra"])[-1]
        if budget["n"] != 1 or budget["missing_budget_fields"]:
            raise ValueError("Native report lacks a shortest-path budget")
        write(output / "result.json", {"task": plan["task"], "target": plan["target"],
            "source_revision": plan["source_revision"], "score": budget["sr"], "budget": budget,
            "episodes": replayed, "parity": "Independent native action replay and original report functions"})
    except Exception as exc:
        write(output / "result.json", {"error": f"{type(exc).__name__}: {exc}"})
        raise


if __name__ == "__main__":
    load_native()
    operation, plan_path = sys.argv[1:]
    plan = read(plan_path)
    if operation == "serve":
        serve(plan)
    elif operation in ("empty", "oracle"):
        calibrate(plan, operation)
    elif operation == "finalize":
        finalize()
    elif operation == "verify":
        verify(plan)
    else:
        raise ValueError(f"Unknown operation: {operation}")
