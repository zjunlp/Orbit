#!/usr/bin/env -S python3 -B
"""BrowserGym/MiniWoB through Orbit adapter protocol 1 (host: Python stdlib only)."""

from importlib import import_module
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

from evidence import BROWSERGYM_VERSION, MINIWOB_COMMIT, PUBLIC_KEY_ENV, SignatureError, read, validate, write

# The shared adapter SDK (examples/sdk/orbit_bench): protocol entry point and score replies.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import main as protocol_main  # noqa: E402

# Bump the suffix whenever the Dockerfile changes, so an image built for an older adapter is not reused.
DEFAULT_IMAGE = f"orbit-browsergym:{BROWSERGYM_VERSION}-3"

HERE = Path(__file__).resolve().parent
sys.path.append(str(HERE.parents[1] / "tools"))
gui_adapter = import_module("orbit-gui-service.adapter")
# Every task browsergym-miniwob registers, snapshotted from the pinned package (not guessed).
TASKS = set(json.loads((HERE / "miniwob_tasks.json").read_text())["tasks"])
CONFIG = {"image", "agentDir", "actionSet", "maxSteps", "suite"}
CLI_TEMPLATE = gui_adapter.CLI_TEMPLATE
# BrowserGym suites that need deployed websites with shared state. Running their tasks in parallel
# lets one task change what another sees, and Orbit has no exclusive scheduling for shared backends
# yet (design §9.6 item 5), so they are refused rather than run under changed conditions.
BACKEND_SUITES = {
    "webarena": "WebArena (shared shopping/reddit/gitlab/map sites)",
    "webarena_verified": "WebArena Verified (same backends as WebArena)",
    "visualwebarena": "VisualWebArena (shared classifieds/shopping/reddit sites)",
    "workarena": "WorkArena (a ServiceNow instance)",
    "assistantbench": "AssistantBench (the open web)",
}


def settings(req):
    b = req["benchmark"]
    c = b["config"]
    if set(c) - CONFIG:
        raise ValueError(f"Unknown BrowserGym config: {', '.join(sorted(set(c) - CONFIG))}")
    suite = c.get("suite", "miniwob")
    if suite in BACKEND_SUITES:
        raise ValueError(f"{BACKEND_SUITES[suite]} needs a deployed backend and exclusive task "
                         "scheduling, which this Orbit version does not provide; only miniwob runs")
    if suite != "miniwob":
        raise ValueError(f"Unknown BrowserGym suite: {suite}")
    root = Path(b["path"]).resolve()
    if not (root / "miniwob/html/miniwob").is_dir():
        raise ValueError("Expected a miniwob-plusplus checkout with miniwob/html/miniwob")
    if c.get("actionSet", "coord") not in ("coord", "bid"):
        raise ValueError("actionSet must be coord (screenshots) or bid (screenshots + accessibility)")
    steps = int(c.get("maxSteps", "20"))
    if not 1 <= steps <= 1000:
        raise ValueError("maxSteps must be between 1 and 1000")
    return root, c, steps


def checkout_revision(root):
    def git(*args):
        return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()
    revision = git("rev-parse", "HEAD")
    if revision != MINIWOB_COMMIT or git("status", "--porcelain", "--", "miniwob/html"):
        raise ValueError(f"Use the unmodified official MiniWoB checkout at {MINIWOB_COMMIT}")
    return revision


def tasks(req):
    root, config, steps = settings(req)
    available = {p.stem for p in (root / "miniwob/html/miniwob").glob("*.html")}
    rows = []
    for task in sorted(available | TASKS):
        reason = ("Not registered by browsergym-miniwob 0.14.3" if task not in TASKS else
                  "Missing original task HTML" if task not in available else None)
        rows.append({"id": f"miniwob.{task}", "title": task, "supported": reason is None,
                     "reason": reason, "tags": {"environment": "browsergym-miniwob"}})
    return {"tasks": rows, "capabilities": {
        "kind": "browser", "methods": ["external", "empty", "cli"], "requires": ["gui"],
        "scoreKind": "binary", "rescore": "evidence", "conditions": {
            "Environment": f"BrowserGym {BROWSERGYM_VERSION}",
            "Task revision": MINIWOB_COMMIT,
            "Observation": "Screenshot + accessibility tree" if config.get("actionSet") == "bid"
                           else "Screenshot",
            "Actions": config.get("actionSet", "coord"), "Step limit": str(steps),
            "CLI instructions": CLI_TEMPLATE,
            "CLI evidence": "Trusted gui service; Agent receives observations only",
            "Coverage": f"Full MiniWoB++ ({len(TASKS)} tasks registered by browsergym-miniwob {BROWSERGYM_VERSION})"}}, "metrics": [
        {"name": "score", "label": "Success", "unit": "%", "primary": True,
         "description": "Original BrowserGym MiniWoB binary reward, averaged over tasks"}]}


def solve(req):
    root, c, steps = settings(req)
    t = req["trial"]
    if t.get("options"):
        raise ValueError("BrowserGym has no trial options; set actionSet/maxSteps at registration")
    if t["task"] not in {f"miniwob.{name}" for name in TASKS}:
        raise ValueError("Task is not registered by browsergym-miniwob")
    if not (root / "miniwob/html/miniwob" / f"{t['task'][8:]}.html").is_file():
        raise ValueError("Original task HTML is missing")
    method = t["method"]
    if method["agent"] in ("oracle", "policy"):
        raise ValueError("BrowserGym has no reference oracle or GPU policy method")
    if method["agent"] == "external" and not re.fullmatch(
            r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*:[A-Za-z_]\w*", method.get("entrypoint", "")):
        raise ValueError("External entrypoint must be module:factory")
    resources = {"cpus": 2, "memGB": 4, "gpus": 0}
    resources.update({k: v for k, v in (t.get("resources") or {}).items() if k != "timeoutMin"})
    if resources["gpus"] != 0:
        raise ValueError("This CPU browser adapter does not support GPU policies")
    revision = checkout_revision(root)
    staging = Path(t["staging"])
    staging.mkdir(parents=True, exist_ok=True)
    for name in ("runtime.py", "episode.py", "evidence.py", "server.py"):
        shutil.copyfile(HERE / name, staging / name)
    gui_adapter.stage_shared(staging)
    plan = {"schema": 1, "task": t["task"], "seed": t["seed"], "method": method,
            "max_steps": steps, "action_set": c.get("actionSet", "coord"),
            "browsergym_version": BROWSERGYM_VERSION, "miniwob_commit": revision}
    if method["agent"] not in ("external", "empty"):
        return cli_solve(t, root, c, resources, staging, plan)
    write(staging / "plan.json", plan)
    mounts = [{"source": str(root / "miniwob/html"), "target": "/miniwob", "mode": "ro"},
              {"source": str(staging), "target": "/adapter", "mode": "ro"}]
    if method["agent"] == "external" and "agentDir" in c:
        agent = Path(c["agentDir"]).expanduser().resolve()
        if not agent.is_dir():
            raise ValueError("agentDir must be a directory containing the external policy")
        mounts.append({"source": str(agent), "target": "/agent", "mode": "ro"})
    return {"spec": {"image": c.get("image", DEFAULT_IMAGE),
                     "command": ["python", "/adapter/runtime.py", "/adapter/plan.json"],
                     "mounts": mounts, "resources": resources,
                     "timeoutMin": t.get("timeoutMin") or 5,
                     "env": {"MINIWOB_URL": "file:///miniwob/miniwob/", "PYTHONPATH": "/agent",
                             "PYTHONDONTWRITEBYTECODE": "1"},
                     "network": method["agent"] == "external"}}



def cli_solve(trial, root, config, resources, staging, plan):
    return gui_adapter.cli_spec(trial, config.get("image", DEFAULT_IMAGE), resources, staging, plan,
        [{"source": str(root / "miniwob/html"), "target": "/miniwob", "mode": "ro"}],
        {"MINIWOB_URL": "file:///miniwob/miniwob/"},
        gui_adapter.instruction("BrowserGym", trial["task"]))


def evidence_root(req):
    root = Path(req["solve"]["output"])
    return root if req["trial"]["method"]["agent"] in ("external", "empty") else root / "services/gui/evidence"



def trusted_public_key(req):
    if req["trial"]["method"]["agent"] in ("external", "empty"):
        return None
    return gui_adapter.trusted_public_key(req)


def verify(req):
    # Revalidate captured evidence; the original task grader already ran inside env.step().
    c = req["benchmark"]["config"]
    key = trusted_public_key(req)
    return {"spec": {"image": c.get("image", DEFAULT_IMAGE),
                     "command": ["python", "/validator/evidence.py", "/solve"],
                     "env": {PUBLIC_KEY_ENV: key} if key is not None else {},
                     "mounts": [{"source": str(gui_adapter.HERE / "evidence.py"),
                                 "target": "/validator/evidence.py", "mode": "ro"},
                                {"source": str(evidence_root(req)),
                                 "target": "/solve", "mode": "ro"}],
                     "network": False, "resources": {"cpus": 1, "memGB": 1, "gpus": 0},
                     "timeoutMin": 1}}


def score(req):
    root = evidence_root(req)
    prefix = "" if root == Path(req["solve"]["output"]) else "services/gui/evidence/"
    review = {"files": [
        {"label": "GUI trajectory", "phase": "solve", "kind": "markdown", "path": "trajectory.md"},
        {"label": "Actions", "phase": "solve", "kind": "text", "path": "trajectory.jsonl"},
        {"label": "Official reward", "phase": "solve", "kind": "json", "path": "result.json"},
        {"label": "Evidence validation", "phase": "verify", "kind": "json", "path": "validation.json"}]}
    for file in review["files"]:
        if file["phase"] == "solve":
            file["path"] = prefix + file["path"]
    if (root / "trajectory-review.json").is_file():
        review["files"].insert(0, {"label": "Trajectory", "phase": "solve", "kind": "trajectory",
                                   "path": prefix + "trajectory-review.json", "fallback": "json"})
    try:
        report = validate(root, trusted_public_key(req))
        verified = read(Path(req["verify"]["output"]) / "validation.json")
        if report != verified:
            raise ValueError("Verifier output disagrees with the saved evidence")
        plan = read(root / "plan.json")
        if any(plan[k] != req["trial"][k] for k in ("task", "seed", "method")):
            raise ValueError("Saved task, seed or method differs from this trial")
        review["details"] = {"environment": f"BrowserGym {plan['browsergym_version']}",
                             "observation": "screenshot" if plan["action_set"] == "coord" else
                             "screenshot + accessibility tree",
                             "action_set": plan["action_set"], "steps": str(report["steps"]),
                             "evaluation": "Live official reward; saved-evidence verification"}
        return {"score": report["reward"], "maxScore": 1, "invalid": False,
                "issues": [], "review": review,
                "episode": episode_summary(root)}
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return {"score": None, "maxScore": 1, "invalid": True,
                "issues": [f"BrowserGym evidence: {exc}"], "review": review,
                "failure": "scorer_error" if isinstance(exc, SignatureError) else evidence_failure(root)}



def episode_summary(root):
    result = read(root / "result.json")
    rows = [json.loads(line) for line in (root / "trajectory.jsonl").read_text().splitlines()]
    return {"steps": result["steps"], "terminated": rows[-1]["terminated"],
            "truncated": rows[-1]["truncated"], "endedBy": result["stop_reason"]}


def evidence_failure(root):
    try:
        stage = read(root / "result.json").get("error_stage")
    except (OSError, ValueError):
        stage = None
    return {"environment_setup": "env_start", "environment_step": "env_step",
            "policy_setup": "policy_start", "policy_action": "policy_act"}.get(stage, "scorer_error")


if __name__ == "__main__":
    sys.exit(protocol_main(tasks, solve, verify, score))
