#!/usr/bin/env -S python3 -B
"""BrowserGym/MiniWoB through Orbit adapter protocol 1 (host: Python stdlib only)."""

import base64
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

from evidence import BROWSERGYM_VERSION, MINIWOB_COMMIT, PRIVATE_KEY_FILE, PUBLIC_KEY_ENV, SignatureError, read, validate, write

HERE = Path(__file__).resolve().parent
# Every task browsergym-miniwob registers, snapshotted from the pinned package (not guessed).
TASKS = set(json.loads((HERE / "miniwob_tasks.json").read_text())["tasks"])
CONFIG = {"image", "agentDir", "actionSet", "maxSteps", "suite"}
CLI_TEMPLATE = "orbit-computer/1: spec, observe original reset goal, act original action, finish"
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
        "kind": "browser", "methods": ["external", "empty", "cli"],
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
    return {"spec": {"image": c.get("image", f"orbit-browsergym:{BROWSERGYM_VERSION}"),
                     "command": ["python", "/adapter/runtime.py", "/adapter/plan.json"],
                     "mounts": mounts, "resources": resources,
                     "timeoutMin": t.get("timeoutMin") or 5,
                     "env": {"MINIWOB_URL": "file:///miniwob/miniwob/", "PYTHONPATH": "/agent",
                             "PYTHONDONTWRITEBYTECODE": "1"},
                     "network": method["agent"] == "external"}}



def cli_solve(trial, root, config, resources, staging, plan):
    if trial.get("hostNetwork"):
        raise ValueError("The GUI service requires a Run private network; disable hostNetwork on the auth profile")
    private_key = staging / PRIVATE_KEY_FILE
    descriptor = os.open(private_key, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    os.close(descriptor)
    private_key.chmod(0o600)
    subprocess.run(["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(private_key)],
                   check=True, capture_output=True, timeout=10)
    public = subprocess.check_output(["openssl", "pkey", "-in", str(private_key),
                                      "-pubout", "-outform", "DER"], timeout=10)
    public_key = base64.b64encode(public).decode()
    plan["review_prefix"] = "services/gui/evidence/"
    write(staging / "plan.json", plan)
    tool = HERE.parent.parent / "tools/orbit-computer/orbit-computer.py"
    image = config.get("image", f"orbit-browsergym:{BROWSERGYM_VERSION}")
    instruction = (
        f"Complete the original BrowserGym task {trial['task']}. "
        "The goal is generated by the environment reset; read it from orbit-computer observe. "
        "First run `orbit-computer spec` to read the exact original action descriptions, then "
        "`orbit-computer observe` and open its screenshot file with your image reader. "
        "Use `orbit-computer act '<action>'` to execute one listed BrowserGym action at a time. "
        "Each response includes the new screenshot path, step and any action error. "
        "Observe does not consume a step. Do not guess action syntax or change the environment. "
        "Call `orbit-computer finish` when finished. The equivalent spec/observe/act/finish MCP "
        "tools are also available when your CLI supports MCP. If a request response is lost, "
        "observe/status first; reuse the original id only for the same action. "
        "Use only the supplied observations to solve the goal; do not inspect task or evaluator source."
    )
    return {"spec": {
        "image": image, "agentTask": {"instruction": instruction},
        "mounts": [{"source": str(tool), "target": "/usr/local/bin/orbit-computer", "mode": "ro"},
                   {"source": str(tool), "target": "/tools/orbit-computer.py", "mode": "ro"}],
        "resources": resources, "timeoutMin": trial.get("timeoutMin") or 5,
        "env": {"ORBIT_GUI_URL": "http://gui:8765", "PYTHONDONTWRITEBYTECODE": "1"},
        "network": True, "networks": [{"name": "gui", "internal": True}],
        "runNetworks": ["default", "gui"], "dependsOn": ["gui"],
        "services": [{"name": "gui", "image": image,
                      "command": ["python", "/adapter/server.py", "/adapter/plan.json", "/evidence"],
                      "binds": [{"source": str(staging), "target": "/adapter", "mode": "ro"},
                                {"source": str(root / "miniwob/html"), "target": "/miniwob", "mode": "ro"}],
                      "env": {"MINIWOB_URL": "file:///miniwob/miniwob/", "PYTHONDONTWRITEBYTECODE": "1",
                              PUBLIC_KEY_ENV: public_key},
                      "cpus": 2, "memGB": 4, "shmGB": 1, "init": True,
                      "networks": ["gui"], "collect": ["/evidence"],
                      "healthcheck": {"command": ["python", "-c",
                          "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/status',timeout=2)"],
                          "intervalSec": 1, "timeoutSec": 3, "startPeriodSec": 20, "retries": 10}}],
        "hooks": [{"service": "gui", "command":
                   "python -c \"import urllib.request; urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8765/finish',data=b'{}',headers={'Content-Type':'application/json'}),timeout=60).read()\"",
                   "timeoutSec": 65}]}}


def evidence_root(req):
    root = Path(req["solve"]["output"])
    return root if req["trial"]["method"]["agent"] in ("external", "empty") else root / "services/gui/evidence"



def trusted_public_key(req):
    if req["trial"]["method"]["agent"] in ("external", "empty"):
        return None
    try:
        service = next(s for s in req["solve"]["run"]["spec"]["services"] if s["name"] == "gui")
        key = service["env"][PUBLIC_KEY_ENV]
        if not isinstance(key, str) or len(base64.b64decode(key, validate=True)) != 44:
            raise ValueError("Invalid service evidence public key")
        return key
    except (KeyError, StopIteration, TypeError, ValueError) as exc:
        raise SignatureError("CLI evidence needs the public key from its saved solve Run") from exc


def verify(req):
    # Revalidate captured evidence; the original task grader already ran inside env.step().
    c = req["benchmark"]["config"]
    key = trusted_public_key(req)
    return {"spec": {"image": c.get("image", f"orbit-browsergym:{BROWSERGYM_VERSION}"),
                     "command": ["python", "/validator/evidence.py", "/solve"],
                     "env": {PUBLIC_KEY_ENV: key} if key is not None else {},
                     "mounts": [{"source": str(HERE / "evidence.py"),
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
