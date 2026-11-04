#!/usr/bin/env -S python3 -B
"""Pinned MobileWorld GUI tasks through Orbit's external adapter protocol."""
import ast
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.parse import urlparse

from evidence import read, validate, write

# The shared adapter SDK (examples/sdk/orbit_bench): protocol entry point and score replies.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import main as protocol_main  # noqa: E402

HERE = Path(__file__).resolve().parent
COMMIT = "a026188705f4a494a12d14ddab3786a23fd2c537"
CONFIG = {"python", "image", "maxSteps", "readyTimeoutSec"}
IMAGE = re.compile(r"ghcr\.io/tongyi-mai/mobile_world@sha256:[a-f0-9]{64}")


def checkout(root):
    revision = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", str(root), "status", "--porcelain", "--", "src", "pyproject.toml", "uv.lock", "docker"], text=True)
    if revision != COMMIT or dirty:
        raise ValueError(f"Use the clean original MobileWorld checkout at {COMMIT}")


def settings(req):
    root = Path(req["benchmark"]["path"]).resolve()
    config = req["benchmark"]["config"]
    if set(config) - CONFIG:
        raise ValueError("Unknown MobileWorld configuration")
    steps = int(config.get("maxSteps", "50"))
    ready = int(config.get("readyTimeoutSec", "600"))
    if not 1 <= steps <= 1000 or not 10 <= ready <= 1800:
        raise ValueError("Invalid step or readiness budget")
    python = Path(config.get("python", str(root / ".venv/bin/python"))).expanduser().absolute()
    checkout(root)
    return root, config, python, steps, ready


def catalog(root):
    rows = []
    for path in sorted((root / "src/mobile_world/tasks/definitions").rglob("*.py")):
        for node in ast.parse(path.read_text()).body:
            if not isinstance(node, ast.ClassDef) or not any(isinstance(b, ast.Name) and b.id == "BaseTask" for b in node.bases):
                continue
            metadata = {}
            for statement in node.body:
                if isinstance(statement, ast.Assign):
                    for target in statement.targets:
                        if isinstance(target, ast.Name) and target.id in ("task_tags", "app_names"):
                            metadata[target.id] = ast.literal_eval(statement.value)
            tags = metadata.get("task_tags", set())
            apps = metadata.get("app_names", set())
            if not isinstance(tags, set) or not isinstance(apps, set):
                raise ValueError(f"Unknown task metadata: {node.name}")
            reason = None
            if "agent-user-interaction" in tags or "agent-mcp" in tags:
                reason = "User-simulator and MCP task conditions are not mapped; GUI-only adapter"
            elif apps & {"Chrome", "Maps"}:
                reason = "Live web/map dependencies are not calibrated; retained in the catalog"
            rows.append({"id": node.name, "title": node.name, "supported": reason is None,
                         "reason": reason, "tags": {"apps": ", ".join(sorted(apps)),
                         "upstream": ", ".join(sorted(tags)), "source": str(path.relative_to(root))}})
    if len(rows) != len({row["id"] for row in rows}) or not rows:
        raise ValueError("Missing or duplicate upstream task classes")
    return rows


def prerequisites(root, config, python):
    reasons = []
    if not os.access("/dev/kvm", os.R_OK | os.W_OK):
        reasons.append("/dev/kvm is unavailable or not readable/writable; software emulation is refused")
    image = config.get("image", "")
    if not IMAGE.fullmatch(image):
        reasons.append("Set image to a prepared official ghcr.io/tongyi-mai/mobile_world@sha256 digest")
    else:
        try:
            subprocess.run(["docker", "image", "inspect", image], check=True, capture_output=True, timeout=15)
        except (OSError, subprocess.SubprocessError):
            reasons.append("The pinned MobileWorld image is not available in Docker")
    try:
        result = subprocess.run([str(python), "-B", "-c", "import sys; assert sys.version_info[:2] == (3,12); import dotenv; dotenv.load_dotenv=lambda *a, **k: False; import mobile_world.core.runner"],
                                env={**os.environ, "PYTHONPATH": str(root / "src"), "PYTHONDONTWRITEBYTECODE": "1", "PYTHON_DOTENV_DISABLED": "1"},
                                capture_output=True, timeout=25)
        if result.returncode:
            reasons.append("Prepare Python 3.12 dependencies with the original frozen uv.lock")
    except (OSError, subprocess.SubprocessError):
        reasons.append("Prepared MobileWorld Python 3.12 interpreter is unavailable")
    return reasons


def tasks(req):
    root, config, python, steps, _ = settings(req)
    reasons = prerequisites(root, config, python)
    rows = catalog(root)
    for row in rows:
        failures = ([row["reason"]] if row["reason"] else []) + reasons
        row.update(supported=not failures, reason="; ".join(failures) or None)
    return {"tasks": rows, "capabilities": {"category": "gui", "profiles": ["mobile", "fixture", "live"], "kind": "mobile", "methods": ["external", "empty"],
        "scoreKind": "scalar", "rescore": "evidence", "conditions": {
            "Source": COMMIT, "Image": config.get("image", "unprepared"), "Observation": "Original screenshot",
            "Actions": "Original JSONAction; no MCP or user simulator", "Step limit": str(steps),
            "Episode": "One mw eval task; concurrency=1, pass-k=1, all task/device retries=0",
            "KVM": "Not in the Orbit device ledger; requires exclusive host access",
            "Coverage": "Original task classes retained; user/MCP and live web/map dependencies unsupported",
            "Seed": "Recorded trial identity only; the native CLI has no task-seed argument",
            "Calibration": "Native emulator checks have not run; see README"}},
        "metrics": [{"name": "score", "label": "Original task score", "unit": "%", "primary": True}]}


def solve(req):
    root, config, python, steps, ready = settings(req)
    trial = req["trial"]
    if trial.get("options") or trial["method"]["agent"] not in ("external", "empty"):
        raise ValueError("MobileWorld supports only external/empty without trial options")
    row = next((row for row in tasks(req)["tasks"] if row["id"] == trial["task"]), None)
    if not row or not row["supported"]:
        raise ValueError(row["reason"] if row else "Task not in the original MobileWorld catalog")
    method = trial["method"]
    if method["agent"] == "external":
        entrypoint = method["entrypoint"]
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", entrypoint):
            raise ValueError("external entrypoint must be a registered upstream Agent name")
        if set(method.get("config", {})) - {"baseUrl"}:
            raise ValueError("Only external config.baseUrl is accepted; pass API_KEY by name")
        base_url = method.get("config", {}).get("baseUrl")
        if base_url:
            parsed = urlparse(base_url)
            if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise ValueError("baseUrl must be an HTTP(S) endpoint without embedded credentials/query")
    resources = {"cpus": 6, "memGB": 12, "gpus": 0}
    resources.update({key: value for key, value in (trial.get("resources") or {}).items() if key != "timeoutMin"})
    if resources["gpus"] != 0 or resources["cpus"] < 2 or resources["memGB"] < 6:
        raise ValueError("MobileWorld needs gpus=0, at least 2 CPUs and 6 GiB including the emulator")
    staging = Path(trial["staging"])
    staging.mkdir(parents=True, exist_ok=True)
    # Copy only adapter code; the original package is imported read-only.
    for name in ("runtime.py", "evidence.py", "empty_agent.py"):
        shutil.copyfile(HERE / name, staging / name)
    plan = {"schema": 1, "source": COMMIT, "root": str(root), "task": trial["task"],
            "seed": trial["seed"], "method": method, "image": config["image"], "max_steps": steps,
            "ready_timeout": ready, "resources": resources}
    write(staging / "plan.json", plan)
    return {"spec": {"backend": "process", "command": [str(python), "-B", str(staging / "runtime.py"), str(staging / "plan.json")],
        "cwd": str(staging), "resources": resources, "timeoutMin": trial.get("timeoutMin") or 30,
        "env": {"PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": str(root / "src"), "PYTHON_DOTENV_DISABLED": "1"}}}


def verify(req):
    return {"spec": {"backend": "process", "command": [sys.executable, "-B", str(HERE / "evidence.py"), req["solve"]["output"]],
                     "resources": {"cpus": 1, "memGB": 1, "gpus": 0}, "timeoutMin": 2}}


def score(req):
    root = Path(req["solve"]["output"])
    review = {"files": [{"label": "Original trajectory", "phase": "solve", "path": f"native/{req['trial']['task']}/traj.json", "kind": "json"},
                         {"label": "Original score", "phase": "solve", "path": f"native/{req['trial']['task']}/result.txt", "kind": "text"},
                         {"label": "Episode evidence", "phase": "solve", "path": "result.json", "kind": "json"}]}
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
                "episode": {"steps": report["steps"], "terminated": report["terminated"],
                            "truncated": not report["terminated"], "endedBy": "terminated" if report["terminated"] else "max_steps"}}
    except (OSError, ValueError, KeyError, TypeError) as exc:
        failure = "scorer_error"
        try:
            failure = read(root / "result.json").get("failure", failure)
        except (OSError, ValueError):
            pass
        if failure not in {"env_start", "reset_failed", "env_step", "policy_start", "policy_act", "model_unavailable", "scorer_error"}:
            failure = "scorer_error"
        return {"score": None, "maxScore": 1, "invalid": True, "failure": failure,
                "issues": [f"MobileWorld evidence: {exc}"], "review": review}


if __name__ == "__main__":
    sys.exit(protocol_main(tasks, solve, verify, score))
