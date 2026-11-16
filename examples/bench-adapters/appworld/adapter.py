#!/usr/bin/env -S python3 -B
"""AppWorld train/dev with private native execution and original task-success grading."""

import hashlib
import json
from pathlib import Path
import shlex
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import invalid, main, pinned, valid
from orbit_bench.batch import mount
from orbit_bench.questions import checked_source

HERE = Path(__file__).resolve().parent
RELEASE = json.loads((HERE / "release.json").read_text())


def catalog(req):
    checked_source(req, HERE)
    cfg = req["benchmark"].get("config") or {}
    split = cfg.get("split", "train")
    if split not in ("train", "dev"):
        raise ValueError("Only public train/dev evaluation is supported")
    data = Path(cfg["data"])
    raw = Path(cfg["dataManifest"]).read_bytes()
    if hashlib.sha256(raw).hexdigest() != cfg.get("dataSha256"):
        raise ValueError("Set dataSha256 to the installed dataManifest SHA-256")
    files = json.loads(raw)
    for name, digest in files.items():
        if Path(name).is_absolute() or ".." in Path(name).parts:
            raise ValueError("Invalid manifest path")
        if hashlib.sha256((data / name).read_bytes()).hexdigest() != digest:
            raise ValueError(f"Installed dataset changed: {name}")
    split_name = f"datasets/{split}.txt"
    if split_name not in files:
        raise ValueError("Dataset manifest must include the split")
    ids = [x.strip() for x in (data / split_name).read_text().splitlines() if x.strip()]
    if any("/" in x or ".." in x for x in ids) or len(set(ids)) != len(ids):
        raise ValueError("Invalid or duplicate task ids")
    return ids, data, cfg


def tasks(req):
    ids, data, cfg = catalog(req)
    return {"tasks": [{"id": task, "title": task, "supported": (data / "tasks" / task / "ground_truth/evaluation.py").is_file(),
        "reason": None if (data / "tasks" / task / "ground_truth/evaluation.py").is_file() else "Original evaluation ground truth is missing"} for task in ids],
        "capabilities": {"identity": {"id": "appworld", "name": "AppWorld", "version": RELEASE["revision"], "variant": cfg.get("split", "train")},
            "methods": ["cli", "external", "oracle", "empty"], "scoreKind": "scalar", "rescore": "evidence",
            "conditions": {"Scoring": "Original AppWorld TestTracker.success; task success, not scenario-group success",
                "Isolation": "Private AppWorld execution service; independent fresh replay of collected code",
                "Budget": "Original default 1000 interactions and native safety guard; public train/dev only"},
            "taxonomy": {"domains": ["business-services"], "taskTypes": ["business-operation"],
                "modalities": ["text", "structured-data"], "interfaces": ["tool-api"], "scoringMethods": ["rule-check"]}}}


def stage(req):
    ids, data, cfg = catalog(req)
    if req["trial"]["task"] not in ids:
        raise ValueError("Unknown AppWorld task")
    if not pinned(cfg.get("image")):
        raise ValueError("Set image to an immutable prepared AppWorld 0.1.3.post1 image")
    item = {"task": req["trial"]["task"], "source": {"code": RELEASE["revision"], "dataSha256": cfg["dataSha256"], "image": cfg["image"]},
            "mode": req["trial"]["method"]["agent"], "maxInteractions": 1000}
    path = Path(req["trial"]["staging"]) / "native"
    path.mkdir(parents=True, exist_ok=True)
    (path / "task.json").write_text(json.dumps(item))
    return path, data, cfg


def native_spec(path, data, cfg):
    return {"image": cfg["image"], "mounts": [mount(HERE / "runtime.py", "/adapter/runtime.py"), mount(path, "/input"), mount(data, "/data")],
            "env": {"PYTHONDONTWRITEBYTECODE": "1"}, "network": False, "workdir": "/tmp",
            "resources": {"cpus": 1, "memGB": 4, "gpus": 0}, "timeoutMin": 30}


def solve(req):
    path, data, cfg = stage(req)
    native = native_spec(path, data, cfg)
    method = req["trial"]["method"]
    if method["agent"] in ("oracle", "empty"):
        native["command"] = ["python", "/adapter/runtime.py", "baseline"]
        return {"spec": native}
    service = {"name": "tools", "image": native["image"], "command": ["python", "/adapter/runtime.py", "serve"],
        "env": native["env"], "binds": native["mounts"], "networks": ["tools"], "cpus": 1, "memGB": 4,
        "collect": ["/evidence/trace.json"],
        "healthcheck": {"command": ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8080/info')"],
                        "intervalSec": 2, "timeoutSec": 2, "retries": 60}}
    run = {"image": cfg.get("subjectImage", "python:3.11-slim@sha256:e88e9763f943ec1834f992a4b51e0f24500486803e8bc534e5767af9ea65f6ce"),
        "mounts": [mount(HERE / "tool.py", "/adapter/tool.py")], "resources": {"cpus": 1, "memGB": 2, "gpus": 0},
        "network": True, "workdir": "/tmp", "networks": [{"name": "tools", "internal": True}],
        "runNetworks": ["default", "tools"], "services": [service], "dependsOn": ["tools"],
        "timeoutMin": req["trial"].get("timeoutMin") or 60}
    if method["agent"] == "external":
        run["command"] = shlex.split(method["entrypoint"])
        if not run["command"] or not run["command"][0]:
            raise ValueError("External entrypoint must contain an executable")
        run["env"] = {"ORBIT_TOOL_URL": "http://tools:8080", "ORBIT_METHOD_CONFIG": json.dumps(method.get("config") or {})}
    else:
        run["agentTask"] = {"instruction": "Solve the AppWorld task from `python /adapter/tool.py info`. "
            "Execute Python against the original AppWorld environment using `python /adapter/tool.py execute FILE` "
            "(or execute - reading stdin). The environment provides apis and requester and retains state across calls. "
            "Read the original API documentation and supervisor context. Complete the task through the supervisor API. "
            "Only service execution changes the environment. The original safety guard, timeouts and 1000 interaction limit apply."}
    return {"spec": run}


def verify(req):
    run = native_spec(*stage(req))
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
        if type(result["success"]) is not bool:
            raise ValueError("Native task success must be boolean")
        return valid(int(result["success"]), review={"files": [
            {"label": "Native interactions", "phase": "solve", "path": "services/tools/evidence/trace.json", "kind": "json"},
            {"label": "Native evaluation", "phase": "verify", "path": "result.json", "kind": "json"}]})
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return invalid("scorer_error", str(exc))


if __name__ == "__main__":
    sys.exit(main(tasks, solve, verify, score))
