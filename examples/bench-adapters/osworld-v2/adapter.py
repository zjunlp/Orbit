#!/usr/bin/env -S python3 -B
"""Release-pinned OSWorld-V2 task catalog and one native Docker episode."""
import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from evidence import read, validate, write

# The shared adapter SDK (examples/sdk/orbit_bench): protocol entry point and score replies.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import main as protocol_main  # noqa: E402

HERE = Path(__file__).resolve().parent
COMMIT = "d9953673daf55381237e058fd9388cc2d74c5538"
RELEASE = "osworld-v2.1"
CONFIG = {"python", "tasksDir", "assetsDir", "vmArchive", "maxSteps"}


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True, timeout=20).strip()


def checkout(root):
    if git(root, "rev-parse", "HEAD") != COMMIT or git(root, "status", "--porcelain", "--", "desktop_env", "mm_agents", "lib_run_single.py", "lib_results_logger.py", "task_loader.py", "benchmark_releases", "pyproject.toml", "uv.lock"):
        raise ValueError(f"Use the clean OSWorld-V2 checkout at {COMMIT}")


def settings(req):
    root = Path(req["benchmark"]["path"]).resolve()
    config = req["benchmark"]["config"]
    if set(config) - CONFIG:
        raise ValueError("Unknown OSWorld-V2 configuration")
    checkout(root)
    release = read(root / "benchmark_releases" / f"{RELEASE}.json")
    hashes_path = root / release["task_hash_manifest"]["path"]
    if "sha256:" + hashlib.sha256(hashes_path.read_bytes()).hexdigest() != release["task_hash_manifest"]["sha256"]:
        raise ValueError("Release task hash manifest changed")
    hashes = read(hashes_path)["files"]
    if len(hashes) != release["task_hash_manifest"]["task_count"]:
        raise ValueError("Release task count mismatch")
    steps = int(config.get("maxSteps", "15"))
    if not 1 <= steps <= 1000:
        raise ValueError("maxSteps must be between 1 and 1000")
    return root, config, release, hashes, steps


def paths(root, config):
    return {"python": str(Path(config.get("python", str(root / ".venv/bin/python"))).expanduser().absolute()),
            "tasks": str(Path(config.get("tasksDir", str(root / "evaluation_examples/task_class"))).expanduser().resolve()),
            "assets": str(Path(config.get("assetsDir", str(root / "cache/osworld_v2_assets"))).expanduser().resolve()),
            "archive": str(Path(config.get("vmArchive", str(root / "docker_vm_data/osworld-v2-ubuntu-x86.qcow2.zip"))).expanduser().resolve())}


def task_conditions(path, expected):
    if not path.is_file():
        return "Release-pinned gated task source is missing"
    data = path.read_bytes()
    if len(data) != expected["size"] or hashlib.sha256(data).hexdigest() != expected["sha256"]:
        return "Task file differs from the release hash manifest"
    tree = ast.parse(data)
    nodes = [item for cls in tree.body if isinstance(cls, ast.ClassDef) for item in cls.body]
    for node in nodes:
        if isinstance(node, ast.FunctionDef) and node.name == "get_phases":
            return "Multi-phase lifecycle is not mapped in this initial single-episode adapter"
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Name) and target.id in {"proxy", "user_simulator", "platform", "image", "instance_type"}:
                    try:
                        value = ast.literal_eval(node.value)
                    except (TypeError, ValueError):
                        return "Dynamic task service/platform conditions require explicit mapping"
                    allowed = {"proxy": (False, None), "user_simulator": (None,), "platform": ("linux", "ubuntu", None),
                               "image": (None,), "instance_type": (None,)}
                    if value not in allowed[target.id]:
                        return f"Task condition {target.id} requires an unsupported provider/service"
    return None


def prerequisites(root, config, release):
    p = paths(root, config)
    reasons = []
    if not os.access("/dev/kvm", os.R_OK | os.W_OK):
        reasons.append("/dev/kvm is unavailable or not readable/writable; software emulation is refused")
    archive = Path(p["archive"])
    image = release["provider_images"]["docker"]["ubuntu"]
    if not archive.is_file() or archive.stat().st_size != image["artifact_size"]:
        reasons.append("The release-pinned original Ubuntu VM archive is missing or incomplete")
    try:
        if git(p["assets"], "rev-parse", "HEAD") != release["assets"]["commit"] or git(p["assets"], "status", "--porcelain"):
            raise ValueError("Assets revision mismatch")
        for filename in git(p["assets"], "ls-files").splitlines():
            asset = Path(p["assets"]) / filename
            if not asset.is_file() or asset.is_symlink():
                raise ValueError("Missing or linked release asset")
            with asset.open("rb") as stream:
                if stream.read(80).startswith(b"version https://git-lfs.github.com/spec/v1"):
                    raise ValueError("Unmaterialized LFS asset")
    except (OSError, ValueError, subprocess.SubprocessError):
        reasons.append("A clean assets Git checkout at the release-pinned commit with materialized LFS files is required")
    try:
        subprocess.run(["docker", "image", "inspect", image["runtime_image"]], check=True, capture_output=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        reasons.append("The release-pinned Docker VM runtime image is not prepared")
    try:
        result = subprocess.run([p["python"], "-B", "-c", "import sys; assert sys.version_info >= (3,12); import dotenv; dotenv.load_dotenv=lambda *a, **k: False; import docker; assert docker.__version__ == '7.1.0'; import desktop_env.desktop_env, lib_run_single"],
                                env={**os.environ, "PYTHONPATH": str(root), "PYTHONDONTWRITEBYTECODE": "1"}, capture_output=True, timeout=25)
        if result.returncode:
            reasons.append("Prepare original Python dependencies from frozen uv.lock, including docker==7.1.0")
    except (OSError, subprocess.SubprocessError):
        reasons.append("Prepared OSWorld Python interpreter is unavailable")
    return reasons


def tasks(req):
    root, config, release, hashes, steps = settings(req)
    common = prerequisites(root, config, release)
    p = paths(root, config)
    rows = []
    for filename, expected in sorted(hashes.items()):
        if Path(filename).name != filename or not filename.endswith(".py"):
            raise ValueError("Unexpected release task path")
        reason = task_conditions(Path(p["tasks"]) / filename, expected)
        failures = ([reason] if reason else []) + common
        rows.append({"id": Path(filename).stem, "title": Path(filename).stem, "supported": not failures,
                     "reason": "; ".join(failures) or None, "tags": {"release": RELEASE, "source_sha256": expected["sha256"]}})
    return {"tasks": rows, "capabilities": {"category": "gui", "profiles": ["desktop", "fixture"], "kind": "desktop", "methods": ["external", "empty"],
        "scoreKind": "scalar", "rescore": "evidence", "conditions": {
            "Code": COMMIT, "Release": RELEASE, "Task revision": release["tasks"]["commit"],
            "Assets revision": release["assets"]["commit"], "VM runtime": release["provider_images"]["docker"]["ubuntu"]["runtime_image"],
            "Observation": "Original screenshot, no accessibility tree or terminal", "Actions": "Original pyautogui",
            "Step limit": str(steps), "Episode": "One native run_single_example; one VM; no setup replay or checkpoint evaluation",
            "KVM": "Not in Orbit's device ledger; requires exclusive host access",
            "Coverage": "All release tasks listed; gated files and external service conditions checked explicitly",
            "Seed": "Recorded trial identity only; the native runner has no task-seed argument",
            "Calibration": "Native VM checks have not run; see README"}},
        "metrics": [{"name": "score", "label": "Original task score", "unit": "%", "primary": True}]}


def solve(req):
    root, config, release, hashes, steps = settings(req)
    trial = req["trial"]
    if trial.get("options") or trial["method"]["agent"] not in ("external", "empty"):
        raise ValueError("Only external/empty methods without trial options are supported")
    row = next((row for row in tasks(req)["tasks"] if row["id"] == trial["task"]), None)
    if not row or not row["supported"]:
        raise ValueError(row["reason"] if row else "Task not in release manifest")
    method = trial["method"]
    if method["agent"] == "external" and method["entrypoint"] != "prompt-agent":
        raise ValueError("Use external entrypoint=prompt-agent for the original PromptAgent")
    if set(method.get("config", {})) - {"temperature", "topP", "maxTokens"}:
        raise ValueError("Unsupported external Agent setting; credentials must use passEnv")
    resources = {"cpus": 5, "memGB": 8, "gpus": 0}
    resources.update({key: value for key, value in (trial.get("resources") or {}).items() if key != "timeoutMin"})
    if resources["gpus"] != 0 or resources["cpus"] < 5 or resources["memGB"] < 8:
        raise ValueError("Original VM needs gpus=0, at least 5 CPUs/8 GiB including its 4 CPU/4 GiB guest")
    p = paths(root, config)
    staging = Path(trial["staging"])
    staging.mkdir(parents=True, exist_ok=True)
    for name in ("runtime.py", "evidence.py"):
        shutil.copyfile(HERE / name, staging / name)
    plan = {"schema": 1, "source": COMMIT, "release": RELEASE, "root": str(root), "paths": p,
            "task": trial["task"], "task_hash": hashes[f"{trial['task']}.py"], "seed": trial["seed"], "method": method,
            "image": release["provider_images"]["docker"]["ubuntu"], "assets_revision": release["assets"]["commit"],
            "max_steps": steps, "resources": resources}
    write(staging / "plan.json", plan)
    return {"spec": {"backend": "process", "command": [p["python"], "-B", str(staging / "runtime.py"), str(staging / "plan.json")],
                     "cwd": str(staging), "resources": resources, "timeoutMin": trial.get("timeoutMin") or 45,
                     "env": {"PYTHONPATH": str(root), "PYTHONDONTWRITEBYTECODE": "1", "OSWORLD_FILE_BASE_URL": p["assets"]}}}


def verify(req):
    return {"spec": {"backend": "process", "command": [sys.executable, "-B", str(HERE / "evidence.py"), req["solve"]["output"]],
                     "resources": {"cpus": 1, "memGB": 1, "gpus": 0}, "timeoutMin": 2}}


def score(req):
    root = Path(req["solve"]["output"])
    review = {"files": [{"label": "Original score", "phase": "solve", "path": "native/result.txt", "kind": "text"},
                         {"label": "Original trajectory", "phase": "solve", "path": "native/traj.jsonl", "kind": "text"},
                         {"label": "Episode evidence", "phase": "solve", "path": "result.json", "kind": "json"}]}
    if (root / "native/result.json").is_file():
        review["files"].append({"label": "Original evaluator details", "phase": "solve", "path": "native/result.json", "kind": "json"})
    if (root / "trajectory-review.json").is_file():
        review["files"].insert(0, {"label": "Saved GUI frames", "phase": "solve", "path": "trajectory-review.json", "kind": "trajectory", "fallback": "json"})
    try:
        report = validate(root)
        if read(Path(req["verify"]["output"]) / "validation.json") != report:
            raise ValueError("Verifier disagrees with saved evidence")
        plan = read(root / "plan.json")
        if any(plan[key] != req["trial"][key] for key in ("task", "seed", "method")):
            raise ValueError("Saved trial identity differs")
        return {"score": report["score"], "maxScore": 1, "invalid": False, "issues": [], "review": review,
                "episode": {"steps": report["steps"], "terminated": report["terminated"], "truncated": not report["terminated"],
                            "endedBy": "terminated" if report["terminated"] else "max_steps"}}
    except (OSError, ValueError, KeyError, TypeError) as exc:
        failure = "scorer_error"
        try: failure = read(root / "result.json").get("failure", failure)
        except (OSError, ValueError): pass
        if failure not in {"env_start", "reset_failed", "env_step", "policy_start", "policy_act", "model_unavailable", "scorer_error"}:
            failure = "scorer_error"
        return {"score": None, "maxScore": 1, "invalid": True, "failure": failure,
                "issues": [f"OSWorld evidence: {exc}"], "review": review}


if __name__ == "__main__":
    sys.exit(protocol_main(tasks, solve, verify, score))
