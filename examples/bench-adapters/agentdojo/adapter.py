#!/usr/bin/env -S python3 -B
"""AgentDojo clean utility with a private native tool service and independent replay."""

import ast
import json
from pathlib import Path
import shlex
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import invalid, main, valid
from orbit_bench.batch import mount
from orbit_bench.questions import checked_source
from orbit_bench.tool_socket import ipc_mount

HERE = Path(__file__).resolve().parent
RELEASE = json.loads((HERE / "release.json").read_text())
SUITES = ("banking", "slack", "travel", "workspace")


def catalog(req):
    checked_source(req, HERE)
    names = set()
    root = Path(req["benchmark"]["path"])
    for name in RELEASE["files"]:
        path = Path(name)
        if path.name != "user_tasks.py":
            continue
        suite = next((s for s in SUITES if s in path.parts), None)
        if not suite:
            continue
        for node in ast.walk(ast.parse((root / name).read_text())):
            if isinstance(node, ast.ClassDef) and node.name.startswith("UserTask") and node.name[8:].isdigit():
                names.add(f"{suite}/user_task_{int(node.name[8:])}")
    return sorted(names)


def tasks(req):
    cfg = req["benchmark"].get("config") or {}
    if cfg.get("attack") or cfg.get("version", "v1.2.2") != "v1.2.2":
        raise ValueError("This adapter supports clean utility at v1.2.2 only")
    return {"tasks": [{"id": name, "title": name, "supported": True, "reason": None, "tags": {"suite": name.split("/")[0]}}
                      for name in catalog(req)],
            "capabilities": {"identity": {"id": "agentdojo", "name": "AgentDojo", "version": RELEASE["revision"], "variant": "v1.2.2-clean"},
                "methods": ["cli", "external", "oracle", "empty"], "scoreKind": "scalar", "rescore": "score",
                "conditions": {"Scoring": "Native clean user-task utility; no attack/security claim",
                    "Isolation": "Private per-trial native tool service; verifier replays service-collected tool calls",
                    "Budget": "At most 64 calls; original task prompt and tool schemas"},
                "taxonomy": {"domains": ["business-services"], "taskTypes": ["business-operation"],
                    "modalities": ["text", "structured-data"], "interfaces": ["tool-api"], "scoringMethods": ["rule-check"]}}}


def stage(req):
    if req["trial"]["task"] not in catalog(req):
        raise ValueError("Unknown AgentDojo task")
    path = Path(req["trial"]["staging"]) / "native"
    path.mkdir(parents=True, exist_ok=True)
    item = {"task": req["trial"]["task"], "revision": RELEASE["revision"], "version": "v1.2.2",
            "mode": req["trial"]["method"]["agent"], "maxCalls": 64}
    (path / "task.json").write_text(json.dumps(item))
    return path


def native_spec(req, path):
    cfg = req["benchmark"].get("config") or {}
    return {**({"image": cfg["image"]} if cfg.get("image") else {"dockerfile": str(HERE / "Dockerfile")}),
            "mounts": [mount(HERE / "runtime.py", "/adapter/runtime.py"), mount(path, "/input"),
                       mount(Path(req["benchmark"]["path"]) / "src", "/native")],
            "env": {"PYTHONPATH": "/native", "PYTHONDONTWRITEBYTECODE": "1"},
            "resources": {"cpus": 1, "memGB": 2, "gpus": 0}, "network": False,
            "workdir": "/tmp", "timeoutMin": 10}


def solve(req):
    path = stage(req)
    method = req["trial"]["method"]
    native = native_spec(req, path)
    if method["agent"] in ("empty", "oracle"):
        native["command"] = ["python", "/adapter/runtime.py", "baseline"]
        return {"spec": native}
    ipc = ipc_mount(req["trial"]["staging"])
    transport = mount(Path(__file__).resolve().parents[2] / "sdk/orbit_bench/tool_socket.py", "/adapter/tool_socket.py")
    service = {"name": "tools", **{k: native[k] for k in ("image", "dockerfile") if k in native},
               "command": ["python", "/adapter/runtime.py", "serve"], "env": native["env"],
               "binds": [*native["mounts"], transport, ipc], "networks": [], "noNetwork": True, "cpus": 1, "memGB": 2,
               "collect": ["/evidence/trace.json"],
               "healthcheck": {"command": ["python", "/adapter/tool_socket.py"],
                               "intervalSec": 2, "timeoutSec": 2, "retries": 30}}
    cfg = req["benchmark"].get("config") or {}
    run = {"image": cfg.get("subjectImage", "python:3.11-slim@sha256:e88e9763f943ec1834f992a4b51e0f24500486803e8bc534e5767af9ea65f6ce"),
           "mounts": [mount(HERE / "tool.py", "/adapter/tool.py"), transport, ipc],
           "resources": {"cpus": 1, "memGB": 2, "gpus": 0}, "workdir": "/tmp",
           "network": True, "services": [service], "dependsOn": ["tools"],
           "timeoutMin": req["trial"].get("timeoutMin") or 20}
    if method["agent"] == "external":
        run["command"] = shlex.split(method["entrypoint"])
        if not run["command"] or not run["command"][0]:
            raise ValueError("External entrypoint must contain an executable")
        run["env"] = {"ORBIT_TOOL_SOCKET": "/ipc/tools.sock", "ORBIT_METHOD_CONFIG": json.dumps(method.get("config") or {})}
    else:
        run["agentTask"] = {"instruction": "Solve the original task from `python /adapter/tool.py info`. It returns the task prompt and tool schemas. "
            "Call tools with `python /adapter/tool.py call FUNCTION 'JSON_ARGS'`; inspect each returned result. "
            "When done, call `python /adapter/tool.py finish 'YOUR_FINAL_ANSWER'`. At most 64 tool calls are allowed. "
            "Only the native tool service records actions and final state; local files do not change the tool environment."}
    return {"spec": run}


def verify(req):
    run = native_spec(req, stage(req))
    run["mounts"].append(mount(req["solve"]["output"], "/solve"))
    run["command"] = ["python", "/adapter/runtime.py", "verify"]
    return {"spec": run}


def score(req):
    try:
        result = json.loads((Path(req["verify"]["output"]) / "result.json").read_text())
        if result["task"] != req["trial"]["task"]:
            raise ValueError("Result task mismatch")
        if result.get("error"):
            return invalid("scorer_error", result["error"])
        if type(result["utility"]) is not bool:
            raise ValueError("Native utility must be boolean")
        return valid(int(result["utility"]), review={"files": [
            {"label": "Trusted tool trace", "phase": "solve", "path": "services/tools/evidence/trace.json", "kind": "json"},
            {"label": "Native utility", "phase": "verify", "path": "result.json", "kind": "json"}]})
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return invalid("scorer_error", str(exc))


if __name__ == "__main__":
    sys.exit(main(tasks, solve, verify, score))
