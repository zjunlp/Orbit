#!/usr/bin/env python3
"""Orbit bench adapter for ResearchClawBench (adapter protocol 1, design §7).

Register:  orbit bench add rcb /path/to/ResearchClawBench --adapter /path/to/adapter.py \
             --pass-env OPENAI_API_KEY --pass-env OPENAI_BASE_URL

Solve: the method's Agent works in a container on the task workspace at /task, laid out as in the
original runner (data/ and related_work/ read-only; code/, outputs/, report/ writable), with the
original instruction template. The RCB venvs are mounted read-only at their host paths.
Verify: a host process runs the original `evaluation.score.score_run` (judge.py) in the RCB `.venv`.

Config (`orbit bench add -c KEY=VALUE`), all optional:
  image         solve image (default: build the Dockerfile next to this file)
  venvs         comma-separated venv directories to mount (default: <path>/.venv-rcb-*)
  cpus, memGB, gpus, timeoutMin   solve resources and timeout (8, 32, 0, 240)
  python        judge Python with openai + structai (default: <path>/.venv/bin/python)
  scoringMode   enhanced | official (default: enhanced, as in the original UI)
  scorerModel   judge model (default: SCORER_MODEL or the original default)
  attempts      judge passes per trial; the score is their mean (default: 1)
  dotenv        1: let the judge read evaluation/.env like the original server (default: 0)
"""

import glob
import json
from pathlib import Path
import os
import statistics
import sys

# The shared adapter SDK (examples/sdk/orbit_bench): protocol entry point and score replies.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import main as protocol_main  # noqa: E402

HERE = os.path.dirname(os.path.realpath(__file__))
WORKSPACE = "/task"
NO_REPORT = "No report found in workspace"
PAPER = 50  # a total of about 50 matches the target paper

# Orbit's `score` is the total in percent of 100; the rest are reported per trial by `score`.
METRICS = [
    {"name": "score", "label": "Score", "unit": "pts",
     "description": "judge total (0-100); about 50 matches the paper", "reference": PAPER},
    {"name": "matched", "label": "Matched paper", "unit": "%", "range": [0, 100],
     "description": f"trials scoring at least {PAPER}"},
    {"name": "judgeSpread", "label": "Judge spread", "unit": "pts", "higherIsBetter": False,
     "description": "sample std of the judge attempts' totals (attempts > 1)"},
]


def config(req, key, default):
    return req["benchmark"]["config"].get(key, default)


def task_dir(req, task):
    return os.path.join(req["benchmark"]["path"], "tasks", task)


# `category` / `profiles` are deprecated compatibility fields (design §9.10).
CAPABILITIES = {"identity": {"id": "researchclawbench", "name": "ResearchClawBench"}, "domains": ["science"], "category": "agent-workspace", "profiles": ["research-report", "judge"], "kind": "other", "methods": ["cli", "empty"], "scoreKind": "scalar", "rescore": "evidence", "calibration": {"oracle": "none", "repeat": {"tolerance": 5}}, "conditions": {"Scoring": "rubric items judged by an LLM against the reference"}}


def tasks(req):
    root = os.path.join(req["benchmark"]["path"], "tasks")
    out = []
    for tid in sorted(os.listdir(root)):
        d = os.path.join(root, tid)
        if not os.path.isfile(os.path.join(d, "task_info.json")):
            continue
        problems = []
        info = {}
        try:
            with open(os.path.join(d, "task_info.json"), encoding="utf-8") as f:
                info = json.load(f)
        except (OSError, ValueError) as e:
            problems.append(f"task_info.json: {e}")
        if not os.path.isfile(os.path.join(d, "target_study", "checklist.json")):
            problems.append("target_study/checklist.json missing")
        title = (info.get("task") or "").strip().split("\n")[0][:160] or None
        out.append({
            "id": tid,
            "title": title,
            "supported": not problems,
            "reason": "; ".join(problems) or None,
            "tags": {"domain": tid.rsplit("_", 1)[0]},
        })
    return {"tasks": out, "metrics": METRICS, "capabilities": CAPABILITIES}


def instruction(req, task):
    """INSTRUCTIONS.md as the original TaskRunner builds it, with the workspace at /task."""
    sys.dont_write_bytecode = True
    sys.path.insert(0, req["benchmark"]["path"])
    from evaluation.instructions_tmpl import INSTRUCTIONS_TEMPLATE

    with open(os.path.join(task_dir(req, task), "task_info.json"), encoding="utf-8") as f:
        info = json.load(f)
    parts = []
    for d in info.get("data", []):
        ws_path = d.get("path", "").lstrip("./")
        data_type = d.get("type", "")
        type_str = f" [{data_type}]" if data_type else ""
        parts.append(f"- **{d['name']}**{type_str} (`{ws_path}`): {d.get('description', '')}")
    return INSTRUCTIONS_TEMPLATE.format(
        workspace=WORKSPACE,
        task_desc=info.get("task", ""),
        data_text="\n".join(parts) if parts else "No specific data files.",
    )


def venvs(req):
    raw = config(req, "venvs", None)
    if raw is not None:
        return [v for v in (x.strip() for x in raw.split(",")) if v]
    return sorted(p for p in glob.glob(os.path.join(req["benchmark"]["path"], ".venv-rcb-*"))
                  if os.path.isdir(p))


def solve(req):
    trial = req["trial"]
    agent = trial["method"]["agent"]
    if agent == "oracle":
        raise ValueError("ResearchClawBench has no reference solution; use empty or an Agent method")
    src = task_dir(req, trial["task"])
    ws = os.path.join(trial["staging"], "workspace")
    # Mount points exist beforehand, so Docker does not create them as root on the host.
    for sub in ("data", "related_work", "code", "outputs", "report/images"):
        os.makedirs(os.path.join(ws, sub), exist_ok=True)
    text = instruction(req, trial["task"])
    with open(os.path.join(ws, "INSTRUCTIONS.md"), "w", encoding="utf-8") as f:
        f.write(text)
    mounts = [{"source": ws, "target": WORKSPACE, "mode": "rw"}]
    for sub in ("data", "related_work"):
        if os.path.isdir(os.path.join(src, sub)):
            mounts.append({"source": os.path.join(src, sub), "target": f"{WORKSPACE}/{sub}",
                           "mode": "ro"})
    for v in venvs(req):
        mounts.append({"source": v, "target": v, "mode": "ro"})
    spec = {
        "resources": {
            "cpus": float(config(req, "cpus", "8")),
            "memGB": float(config(req, "memGB", "32")),
            "gpus": int(config(req, "gpus", "0")),
        },
        "mounts": mounts,
        "workdir": WORKSPACE,
        "network": True,
        "timeoutMin": trial.get("timeoutMin") or float(config(req, "timeoutMin", "240")),
        "collect": [f"{WORKSPACE}/{p}" for p in ("INSTRUCTIONS.md", "code", "outputs", "report")],
    }
    image = config(req, "image", None)
    if image:
        spec["image"] = image
    else:
        spec["dockerfile"] = os.path.join(HERE, "rcb-solve", "Dockerfile")
    if agent == "empty":
        spec["command"] = ["true"]
    else:
        spec["agentTask"] = {"instruction": text}
    return {"spec": spec}


def verify(req):
    b = req["benchmark"]
    trial = req["trial"]
    python = config(req, "python", os.path.join(b["path"], ".venv", "bin", "python"))
    command = [
        python, os.path.join(HERE, "judge.py"),
        "--rcb", b["path"],
        "--task", trial["task"],
        "--run-id", trial["id"],
        "--agent", trial["method"]["name"],
        "--collected", os.path.join(req["solve"]["output"], "collected", WORKSPACE.lstrip("/")),
        "--mode", config(req, "scoringMode", "enhanced"),
        "--attempts", config(req, "attempts", "1"),
    ]
    if config(req, "scorerModel", ""):
        command += ["--model", config(req, "scorerModel", "")]
    if config(req, "dotenv", "0") == "1":
        command.append("--dotenv")
    return {"spec": {
        "backend": "process",
        "command": command,
        "resources": {"cpus": 1, "memGB": 2, "gpus": 0},
        "env": {"PYTHONDONTWRITEBYTECODE": "1"},
        "timeoutMin": 60,
    }}


def review(req, attempts):
    """What the Orbit trial page shows: the report, the judge's per-item scores and settings."""
    solve_out = req["solve"]["output"]
    files = []
    report = os.path.join(solve_out, "collected", WORKSPACE.lstrip("/"), "report", "report.md")
    if os.path.isfile(report):
        files.append({"label": "Report", "phase": "solve", "kind": "markdown",
                      "path": os.path.relpath(report, solve_out)})
    instructions = os.path.join(solve_out, "collected", WORKSPACE.lstrip("/"), "INSTRUCTIONS.md")
    if os.path.isfile(instructions):
        files.append({"label": "Instructions", "phase": "solve", "kind": "markdown",
                      "path": os.path.relpath(instructions, solve_out)})
    items = []
    details = {}
    score_file = os.path.join(req["verify"]["output"], "workspaces", req["trial"]["id"], "_score.json")
    try:
        with open(score_file, encoding="utf-8") as f:
            data = json.load(f)
        for it in data.get("items", []):
            items.append({
                "criterion": str(it.get("content", "")),
                "type": str(it.get("type", "")),
                "weight": float(it.get("weight", 1.0)),
                "score": it.get("score"),
                "maxScore": 100,
                "reasoning": str(it.get("reasoning", "")),
            })
        details = {
            "scorer model": data.get("scorer_model"),
            "scoring mode": data.get("scoring_mode"),
            "total weight": data.get("total_weight"),
        }
        files.append({"label": "Judge result", "phase": "verify", "kind": "json",
                      "path": os.path.relpath(score_file, req["verify"]["output"])})
    except (OSError, ValueError):
        pass
    if len(attempts) > 1:
        details["attempts"] = ", ".join(f"{a['total']:.2f}" for a in attempts if "total" in a)
    return {"files": files, "items": items,
            "details": {k: v for k, v in details.items() if v is not None}}


def score(req):
    def bad(issue):
        return {"score": None, "maxScore": 100, "invalid": True, "issues": [issue]}

    try:
        with open(os.path.join(req["verify"]["output"], "result.json"), encoding="utf-8") as f:
            attempts = json.load(f)["attempts"]
    except (OSError, ValueError, KeyError):
        return bad("judge wrote no result")
    if not attempts:
        return bad("judge ran no attempt")
    if len(attempts) == 1 and attempts[0].get("error") == NO_REPORT:
        # The method produced no report: its result, scored zero.
        return {"score": 0, "maxScore": 100, "issues": ["no report in report/"],
                "metrics": {"matched": 0}, "review": review(req, attempts)}
    issues = []
    for i, a in enumerate(attempts, 1):
        if "error" in a:
            return bad(f"judge: {a['error']} (attempt {i})")
        if a["failedItems"]:
            issues.append(f"judge failed on {len(a['failedItems'])}/{a['items']} checklist items"
                          f" (attempt {i})")
    invalid = bool(issues)
    totals = [a["total"] for a in attempts]
    total = sum(totals) / len(totals)
    metrics = {"matched": 100 if total >= PAPER else 0}
    if len(totals) > 1:
        issues.append("judge attempts: " + ", ".join(f"{t:.2f}" for t in totals))
        metrics["judgeSpread"] = statistics.stdev(totals)
    return {"score": total, "maxScore": 100, "invalid": invalid, "issues": issues,
            "metrics": metrics, "review": review(req, attempts)}


if __name__ == "__main__":
    sys.exit(protocol_main(tasks, solve, verify, score))
