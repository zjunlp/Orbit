#!/usr/bin/env -S python3 -B
"""RobotAgentBench raw-22 tools; Orbit owns the CLI, services and independent verify."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "sdk"))
from orbit_bench import main, valid, invalid, pinned

REVISION = "fa207f52d8da139f591f9dc590eb002c58f72383"
CONFIG = {"prepared", "image"}
PUBLIC_KEY = "ORBIT_RAB_EVIDENCE_PUBLIC_KEY"
SPECIAL = ("coffee_bag_interference", "coffee_machine_push_interference",
           "coffee_bag_then_machine_interference", "coffee_button_lighting_interference")


def read(path):
    return json.loads(Path(path).read_text())


def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def catalog(root):
    release = read(root / "resources/saved-instances-0.2.17.json")
    groups = {}
    for archive in release["archives"].values():
        for name in archive["members"]:
            match = re.fullmatch(r"instances/([^/]+)/([^/]+)/(\d+)\.json", name)
            if match:
                task = match[1] + "/" + match[2]
                groups.setdefault(task, set()).add(int(match[3]))
    if len(groups) != 49 or any(values != set(range(1, 31)) for values in groups.values()):
        raise ValueError("Expected the complete 49-group, 1470-configuration native release")
    return groups


def native_reason(task):
    family, name = task.split("/")
    if family == "cloth" or name.startswith("failure_recovery_") or name in SPECIAL:
        return "Dedicated native cloth/recovery/atomic owner is not wired into this raw-room profile"
    if name in ("host_guests", "prepare_dinner", "prepare_to_leave", "tidy_room") or name.startswith("task_discovery--"):
        return "OpenEnd/discovery requires a separate native score profile; no fixed denominator is invented"
    return None


def settings(req):
    config = req["benchmark"].get("config", {})
    if set(config) - CONFIG:
        raise ValueError("Unknown RobotAgentBench config keys")
    root = Path(req["benchmark"]["path"]).resolve()
    head = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    if head != REVISION or subprocess.run(["git", "-C", str(root), "diff", "--quiet", "HEAD", "--"]).returncode:
        raise ValueError("Use the clean pinned RobotAgentBench source")
    prepared = read(config["prepared"]) if config.get("prepared") else {"version": 1, "episodes": {}}
    if prepared.get("version") != 1 or prepared.get("revision", REVISION) != REVISION:
        raise ValueError("Prepared native episodes have another source revision")
    return root, config, prepared


def tasks(req):
    root, _, prepared = settings(req)
    rows = []
    for task in sorted(catalog(root)):
        entries = prepared["episodes"].get(task, {})
        reason = native_reason(task) or (None if entries else "Prepare the saved native Runtime, launch and image first")
        rows.append({"id": task, "title": task.replace("_", " "), "supported": reason is None, "reason": reason,
            "tags": {"suite": task.split("/")[0], "savedConfigurations": "30",
                     "preparedConfigurations": str(len(entries)), "profile": "native-raw22"}})
    return {"tasks": rows, "capabilities": {
        "identity": {"id": "robotagentbench", "name": "RobotAgentBench", "version": REVISION, "variant": "raw22"},
        "methods": ["cli", "empty"], "requires": ["mcp"], "scoreKind": "scalar", "rescore": "evidence",
        "calibration": {"empty": "any", "oracle": "none", "seedsVary": True},
        "taxonomy": {"domains": ["robotics"], "taskTypes": ["manipulation", "navigation"],
            "targets": ["planning", "tool-use", "perception-grounding", "control"],
            "modalities": ["text", "image", "structured-data"], "interfaces": ["tool-api"],
            "platforms": ["simulation"], "world": ["controlled"], "feedback": ["step"],
            "scoringEvidence": ["trajectory", "final-state"], "scoringMethods": ["rule-check"]},
        "conditions": {"Target": "Agent CLI with original raw robot tools; no model loop in this adapter",
            "Protocol": "Native 22D physical-unit action chunks at 20 Hz; no IK or action projection",
            "Instances": "Orbit seed is saved configuration ordinal 1..30, not a sampling RNG seed",
            "Scoring": "Native terminal total / native maximum; unfinished or uncertain episodes are invalid",
            "Limits": "Dedicated cloth/recovery/atomic owners and OpenEnd/discovery score profiles remain unsupported"}},
        "metrics": [{"name": "score", "label": "Native normalized process score", "primary": True},
                    {"name": "success_rate", "label": "Native success", "unit": "ratio", "range": [0, 1]}]}


def copy_runtime(source, destination):
    if destination.exists():
        raise ValueError("Staging Runtime must be fresh")
    subprocess.run(["cp", "-a", "--reflink=auto", str(source), str(destination)],
                   check=True, timeout=90)


def solve(req):
    root, config, prepared = settings(req)
    trial = req["trial"]
    task, ordinal = trial["task"], trial["seed"]
    if task not in catalog(root) or native_reason(task):
        raise ValueError(native_reason(task) or "Unknown native task")
    if type(ordinal) is not int or not 1 <= ordinal <= 30:
        raise ValueError("Use saved configuration ordinals 1..30")
    if trial.get("options") or trial.get("hostNetwork"):
        raise ValueError("No per-trial native overrides or host-network methods")
    if trial["method"]["agent"] in ("oracle", "policy", "external"):
        raise ValueError("Use a registered Agent CLI or the explicit empty control")
    entry = prepared["episodes"].get(task, {}).get(str(ordinal))
    if not entry:
        raise ValueError("The selected saved configuration has not been prepared")
    image = config.get("image", "")
    if not pinned(image) or not pinned(entry["image"]):
        raise ValueError("Both Agent and native images need immutable IDs")
    for path, value in entry["files"].items():
        if sha(path) != value:
            raise ValueError("Prepared native input changed; prepare a new registration")
    runtime = Path(entry["runtime"])
    stage = Path(trial["staging"])
    stage.mkdir(parents=True, exist_ok=True)
    copy_runtime(runtime, stage / "runtime")
    for name in ("service.py", "verify.py", "proxy.py"):
        shutil.copyfile(HERE / name, stage / name)
    shutil.copyfile(HERE.parents[1] / "tools/orbit-gui-service/evidence.py", stage / "evidence_helpers.py")
    key = stage / "private.pem"
    key.touch(mode=0o600, exist_ok=False)
    subprocess.run(["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(key)], check=True, capture_output=True)
    public = base64.b64encode(subprocess.check_output(
        ["openssl", "pkey", "-in", str(key), "-pubout", "-outform", "DER"])).decode()
    nonce = uuid.uuid4().hex
    native_output = entry["outputPrefix"] + "/" + nonce + "/native"
    argv = [value.replace("{output}", native_output) for value in entry["command"]]
    binds = []
    for bind in entry["binds"]:
        actual = Path(bind["source"])
        if actual == runtime or runtime in actual.parents:
            actual = stage / "runtime" / actual.relative_to(runtime)
        binds.append({**bind, "source": str(actual)})
    plan = {"version": 1, "revision": REVISION, "trial": trial["id"], "task": task,
            "nativeTask": entry["nativeTask"], "ordinal": ordinal, "method": trial["method"],
            "uid": os.getuid(), "gid": os.getgid(), "command": argv, "nativeOutput": native_output, "runtimeFiles": prepared["sourceFiles"], "deployment": entry["deployment"], "runtime": str(runtime)}
    (stage / "plan.json").write_text(json.dumps(plan))
    resources = {"cpus": 2, "memGB": 4, "gpus": 0, **(trial.get("resources") or {})}
    resources.pop("timeoutMin", None)
    if resources["gpus"] != 0:
        raise ValueError("The native service owns the simulator GPU")
    spec = {"image": image, "resources": resources, "timeoutMin": trial.get("timeoutMin") or 120,
        "network": trial["method"]["agent"] != "empty",
        "networks": [{"name": "robot", "internal": True}],
        "runNetworks": ["robot"] if trial["method"]["agent"] == "empty" else ["default", "robot"],
        "dependsOn": ["environment"],
        "mounts": [{"source": str(stage / "proxy.py"), "target": "/tools/robot.py", "mode": "ro"}],
        "services": [{"name": "environment", "image": entry["image"], "role": "sim",
            "entrypoint": "/usr/local/bin/python3.11", "command": ["/adapter/service.py", "serve"],
            "binds": [*binds, {"source": str(stage), "target": "/adapter", "mode": "ro"}],
            "env": {**entry["env"], PUBLIC_KEY: public, "PYTHONDONTWRITEBYTECODE": "1"},
            "cpus": 8, "memGB": 32, "gpus": 1, "gpuMemGB": 16, "gpuModels": ["RTX", "L4", "L40", "L40S", "A10", "A40"],
            "init": True, "networks": ["robot"], "collect": ["/evidence"],
            "healthcheck": {"command": ["/usr/local/bin/python3.11", "/adapter/service.py", "ready"],
                            "intervalSec": 5, "timeoutSec": 5, "startPeriodSec": 900, "retries": 3}}],
        "hooks": [{"service": "environment", "command": "/usr/local/bin/python3.11 /adapter/service.py finalize",
                   "timeoutSec": 600}]}
    if trial["method"]["agent"] == "empty":
        spec["command"] = ["python", "/tools/robot.py", "empty"]
    else:
        spec["agentTask"] = {"instruction": "Use the robot MCP tools to complete the native task. "
            "Call observe first; it provides the original instruction, contract and camera observations. "
            "Actions use the exact native 22D physical-unit order at 20 Hz. "
            "Task completion is determined by the native environment, not a prose claim.",
            "tools": [{"name": "robot", "command": ["python", "/tools/robot.py"]}]}
    return {"spec": spec, "issues": []}


def verify(req):
    root, config, _ = settings(req)
    stage = Path(req["trial"]["staging"])
    service = req["solve"]["run"]["spec"]["services"][0]
    public = service["env"][PUBLIC_KEY]
    return {"spec": {"image": config["image"], "network": False,
        "command": ["python", "/adapter/verify.py", "/solve"], "timeoutMin": 10,
        "resources": {"cpus": 2, "memGB": 4, "gpus": 0},
        "env": {"PYTHONPATH": "/upstream/src", PUBLIC_KEY: public},
        "mounts": [{"source": str(stage), "target": "/adapter", "mode": "ro"},
                   {"source": str(root), "target": "/upstream", "mode": "ro"},
                   {"source": str(Path(req["solve"]["output"]) / "services/environment/evidence"),
                    "target": "/solve", "mode": "ro"}]}}


def score(req):
    review = {"files": [{"label": "Native receipt verification", "phase": "verify", "path": "result.json", "kind": "json"}]}
    try:
        result = read(Path(req["verify"]["output"]) / "result.json")
        plan = result["plan"]
        if plan["revision"] != REVISION or not result["valid"] or any(plan[key] != req["trial"][key] for key in ("task", "method")):
            raise ValueError(result.get("error", "Native evidence belongs to another trial"))
        if plan["ordinal"] != req["trial"]["seed"] or plan["trial"] != req["trial"]["id"]:
            raise ValueError("Saved native instance or trial identity mismatch")
        return valid(result["score"], metrics={"success_rate": int(result["success"])}, review=review)
    except (OSError, KeyError, ValueError, TypeError) as exc:
        return invalid("scorer_error", str(exc), review=review)


if __name__ == "__main__":
    raise SystemExit(main(tasks, solve, verify, score))
