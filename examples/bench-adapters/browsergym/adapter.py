#!/usr/bin/env -S python3 -B
"""BrowserGym/MiniWoB through Orbit adapter protocol 1 (host: Python stdlib only)."""

import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

from evidence import BROWSERGYM_VERSION, MINIWOB_COMMIT, read, validate, write

HERE = Path(__file__).resolve().parent
TASKS = {"click-test", "click-test-2", "click-button", "enter-text", "click-checkboxes"}
CONFIG = {"image", "agentDir", "actionSet", "maxSteps"}


def settings(req):
    b = req["benchmark"]
    c = b["config"]
    if set(c) - CONFIG:
        raise ValueError(f"Unknown BrowserGym config: {', '.join(sorted(set(c) - CONFIG))}")
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
        reason = ("Outside the phase-one MiniWoB subset" if task not in TASKS else
                  "Missing original task HTML" if task not in available else None)
        rows.append({"id": f"miniwob.{task}", "title": task, "supported": reason is None,
                     "reason": reason, "tags": {"environment": "browsergym-miniwob"}})
    return {"tasks": rows, "capabilities": {
        "kind": "browser", "methods": ["external", "empty"],
        "scoreKind": "binary", "rescore": "evidence", "conditions": {
            "Environment": f"BrowserGym {BROWSERGYM_VERSION}",
            "Task revision": MINIWOB_COMMIT,
            "Observation": "Screenshot + accessibility tree" if config.get("actionSet") == "bid"
                           else "Screenshot",
            "Actions": config.get("actionSet", "coord"), "Step limit": str(steps),
            "Coverage": "Five-task integration subset"}}, "metrics": [
        {"name": "score", "label": "Success", "unit": "%", "primary": True,
         "description": "Original BrowserGym MiniWoB binary reward, averaged over tasks"}]}


def solve(req):
    root, c, steps = settings(req)
    t = req["trial"]
    if t.get("options"):
        raise ValueError("BrowserGym has no trial options; set actionSet/maxSteps at registration")
    if t["task"] not in {f"miniwob.{name}" for name in TASKS}:
        raise ValueError("Task is outside the phase-one MiniWoB subset")
    if not (root / "miniwob/html/miniwob" / f"{t['task'][8:]}.html").is_file():
        raise ValueError("Original task HTML is missing")
    method = t["method"]
    if method["agent"] not in ("external", "empty"):
        raise ValueError("BrowserGym supports external and empty; no reference oracle is provided")
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
    for name in ("runtime.py", "evidence.py"):
        shutil.copyfile(HERE / name, staging / name)
    plan = {"schema": 1, "task": t["task"], "seed": t["seed"], "method": method,
            "max_steps": steps, "action_set": c.get("actionSet", "coord"),
            "browsergym_version": BROWSERGYM_VERSION, "miniwob_commit": revision}
    write(staging / "plan.json", plan)
    mounts = [{"source": str(root / "miniwob/html"), "target": "/miniwob", "mode": "ro"},
              {"source": str(staging), "target": "/adapter", "mode": "ro"}]
    if method["agent"] == "external" and "agentDir" in c:
        agent = Path(c["agentDir"]).expanduser().resolve()
        if not agent.is_dir():
            raise ValueError("agentDir must be a directory containing the external policy")
        mounts.append({"source": str(agent), "target": "/agent", "mode": "ro"})
    return {"spec": {"image": c.get("image", f"orbit-browsergym:{BROWSERGYM_VERSION}"),
                     "command": ["python", "/adapter/runtime.py", "/adapter/plan.json"],
                     "mounts": mounts, "resources": resources,
                     "timeoutMin": t.get("timeoutMin") or 5,
                     "env": {"MINIWOB_URL": "file:///miniwob/miniwob/", "PYTHONPATH": "/agent",
                             "PYTHONDONTWRITEBYTECODE": "1"},
                     "network": method["agent"] == "external"}}


def verify(req):
    # Revalidate captured evidence; the original task grader already ran inside env.step().
    c = req["benchmark"]["config"]
    return {"spec": {"image": c.get("image", f"orbit-browsergym:{BROWSERGYM_VERSION}"),
                     "command": ["python", "/validator/evidence.py", "/solve"],
                     "mounts": [{"source": str(HERE / "evidence.py"),
                                 "target": "/validator/evidence.py", "mode": "ro"},
                                {"source": req["solve"]["output"],
                                 "target": "/solve", "mode": "ro"}],
                     "network": False, "resources": {"cpus": 1, "memGB": 1, "gpus": 0},
                     "timeoutMin": 1}}


def score(req):
    review = {"files": [
        {"label": "GUI trajectory", "phase": "solve", "kind": "markdown", "path": "trajectory.md"},
        {"label": "Actions", "phase": "solve", "kind": "text", "path": "trajectory.jsonl"},
        {"label": "Official reward", "phase": "solve", "kind": "json", "path": "result.json"},
        {"label": "Evidence validation", "phase": "verify", "kind": "json", "path": "validation.json"}]}
    if (Path(req["solve"]["output"]) / "trajectory-review.json").is_file():
        review["files"].insert(0, {"label": "Trajectory", "phase": "solve", "kind": "trajectory",
                                   "path": "trajectory-review.json", "fallback": "json"})
    try:
        report = validate(Path(req["solve"]["output"]))
        verified = read(Path(req["verify"]["output"]) / "validation.json")
        if report != verified:
            raise ValueError("Verifier output disagrees with the saved evidence")
        plan = read(Path(req["solve"]["output"]) / "plan.json")
        if any(plan[k] != req["trial"][k] for k in ("task", "seed", "method")):
            raise ValueError("Saved task, seed or method differs from this trial")
        review["details"] = {"environment": f"BrowserGym {plan['browsergym_version']}",
                             "observation": "screenshot" if plan["action_set"] == "coord" else
                             "screenshot + accessibility tree",
                             "action_set": plan["action_set"], "steps": str(report["steps"]),
                             "evaluation": "Live official reward; saved-evidence verification"}
        return {"score": report["reward"], "maxScore": 1, "invalid": False,
                "issues": [], "review": review}
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return {"score": None, "maxScore": 1, "invalid": True,
                "issues": [f"BrowserGym evidence: {exc}"], "review": review}


def main():
    try:
        op = sys.argv[1]
        req = json.load(sys.stdin)
        if req.get("protocol") != 1 or req.get("op") != op:
            raise ValueError("Expected adapter protocol 1 and a matching operation")
        json.dump({"tasks": tasks, "solve": solve, "verify": verify, "score": score}[op](req),
                  sys.stdout, ensure_ascii=False, allow_nan=False)
    except Exception as exc:
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
