#!/usr/bin/env -S python3 -B
"""Official SWE-bench Lite scripts and grading in Orbit-owned instance containers."""

import json
from pathlib import Path
import shlex
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import invalid, main, pinned, valid
from orbit_bench.batch import mount
from orbit_bench.questions import checked_source, dataset

HERE = Path(__file__).resolve().parent
RELEASE = json.loads((HERE / "release.json").read_text())


def inputs(req):
    checked_source(req, HERE)
    cfg = req["benchmark"].get("config") or {}
    if cfg.get("variant", "Lite-test") != "Lite-test":
        raise ValueError("Only SWE-bench Lite test is supported")
    rows, digest = dataset(req, "swebench-lite.json")
    if len({r["instance_id"] for r in rows}) != len(rows):
        raise ValueError("Duplicate instance ids")
    images = json.loads(Path(cfg["imageMap"]).read_text()) if cfg.get("imageMap") else {}
    if not isinstance(images, dict) or any(not pinned(v) for v in images.values()):
        raise ValueError("imageMap must map instance ids to immutable, prepared official instance images")
    return rows, digest, images


def tasks(req):
    rows, _, images = inputs(req)
    return {"tasks": [{"id": r["instance_id"], "title": r["instance_id"],
        "supported": r["instance_id"] in images,
        "reason": None if r["instance_id"] in images else "Install the official instance image and add its immutable id to imageMap",
        "tags": {"repo": r["repo"]}} for r in rows],
        "capabilities": {"identity": {"id": "swebench", "name": "SWE-bench", "version": RELEASE["revision"], "variant": "Lite-test"},
            "methods": ["cli", "external", "oracle", "empty"], "scoreKind": "scalar", "rescore": "evidence",
            "conditions": {"Scoring": "Official 3.0.15 test script, log parser and F2P/P2P resolved decision",
                "Isolation": "Fresh instance image; private test patch and reference; no Docker socket",
                "Input": "Original problem_statement and repository; no hints_text"},
            "taxonomy": {"domains": ["software"], "taskTypes": ["repair"],
                "modalities": ["text"], "interfaces": ["terminal"], "scoringMethods": ["execution-test"]}}}


def stage(req, phase):
    rows, digest, images = inputs(req)
    task = req["trial"]["task"]
    row = next((r for r in rows if r["instance_id"] == task), None)
    if row is None or task not in images:
        raise ValueError("Unknown task or missing immutable instance image")
    f2p = json.loads(row["FAIL_TO_PASS"]) if isinstance(row["FAIL_TO_PASS"], str) else row["FAIL_TO_PASS"]
    if not f2p:
        raise ValueError("Scoring requires published FAIL_TO_PASS tests")
    visible = {"task": task, "source": {"dataSha256": digest, "harness": RELEASE["revision"], "image": images[task]},
               "base_commit": row["base_commit"], "problem_statement": row["problem_statement"]}
    path = Path(req["trial"]["staging"]) / phase
    path.mkdir(parents=True, exist_ok=True)
    if phase == "verify":
        saved = json.loads((Path(req["solve"]["output"]) / "collected/input/task.json").read_text())
        saved.pop("patch", None)
        if saved != visible:
            raise ValueError("Instance, dataset or image changed since solve")
        (path / "instance.json").write_text(json.dumps(row))
    elif req["trial"]["method"]["agent"] == "oracle":
        visible["patch"] = row["patch"]
    (path / "task.json").write_text(json.dumps(visible))
    return path, images[task]


def run_spec(path, image):
    return {"image": image, "mounts": [mount(path, "/input"), mount(HERE / "runtime.py", "/adapter/runtime.py")],
            "env": {"PYTHONDONTWRITEBYTECODE": "1"}, "network": False, "workdir": "/testbed",
            "resources": {"cpus": 2, "memGB": 8, "gpus": 0}, "timeoutMin": 60}


def solve(req):
    run = run_spec(*stage(req, "solve"))
    run["collect"] = ["/input/task.json"]
    run["timeoutMin"] = req["trial"].get("timeoutMin") or 60
    method = req["trial"]["method"]
    if method["agent"] in ("oracle", "empty"):
        run["command"] = ["python", "/adapter/runtime.py", method["agent"]]
    elif method["agent"] == "external":
        run["command"] = shlex.split(method["entrypoint"])
        if not run["command"] or not run["command"][0]:
            raise ValueError("External entrypoint must contain an executable")
        run["env"].update({"ORBIT_TASK_FILE": "/input/task.json", "ORBIT_METHOD_CONFIG": json.dumps(method.get("config") or {})})
        run["network"] = True
    else:
        run["network"] = True
        run["agentTask"] = {"instruction": "Fix the issue in /input/task.json in the repository /testbed. "
            "Write your final unified diff to $ORBIT_OUTPUT/model.patch (for example git diff BASE_COMMIT). "
            "Keep the original tests intact. Only model.patch is evaluated in a fresh container. "
            "An empty or inapplicable patch receives zero. Do not output a self-reported score."}
    return {"spec": run}


def verify(req):
    run = run_spec(*stage(req, "verify"))
    cfg = req["benchmark"].get("config") or {}
    deps = Path(cfg["harnessDeps"])
    if not (deps / "swebench/harness/grading.py").is_file():
        raise ValueError("harnessDeps must contain the Python 3.11 SWE-bench 3.0.15 installation")
    run["mounts"] += [mount(req["solve"]["output"], "/solve"), mount(deps, "/deps"),
                      mount(Path(req["benchmark"]["path"]) / "swebench", "/native/swebench")]
    run["env"]["PYTHONPATH"] = "/native:/deps"
    run["network"] = True
    run["command"] = ["python", "/adapter/runtime.py", "verify"]
    return {"spec": run}


def score(req):
    try:
        result = json.loads((Path(req["verify"]["output"]) / "result.json").read_text())
        if result["task"] != req["trial"]["task"]:
            raise ValueError("Result task mismatch")
        if result.get("error"):
            return invalid("scorer_error", result["error"])
        if type(result["resolved"]) is not bool:
            raise ValueError("Native resolved must be boolean")
        return valid(int(result["resolved"]), review={"files": [
            {"label": "Submitted patch", "phase": "solve", "path": "model.patch", "kind": "text"},
            {"label": "Official test output", "phase": "verify", "path": "test_output.txt", "kind": "text"},
            {"label": "Official report", "phase": "verify", "path": "result.json", "kind": "json"}]})
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return invalid("scorer_error", str(exc))


if __name__ == "__main__":
    sys.exit(main(tasks, solve, verify, score))
