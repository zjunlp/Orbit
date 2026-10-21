#!/usr/bin/env python3
"""LongDS native multi-turn runners and judge through Orbit adapter protocol 1."""

import json
import math
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
IDENTITY = ("task_domain", "dataset_name", "task_id")
RUNNERS = {"codex": "codex/run_codex_longds.py",
           "claude-code": "claude_code/run_claude_longds.py"}
CONFIG = {"dataset", "version", "split", "image", "python", "cpus", "memGB", "timeoutMin",
          "turnTimeoutSec", "analysisPython", "judgeWorkers", "judgeRetries", "judgeTimeoutMin"}
METRICS = [{"name": "score", "label": "Task turn accuracy", "unit": "%", "primary": True,
            "description": "Original LongDS judge: mean binary correctness over every task turn"}]


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def component(value):
    if not isinstance(value, str) or not value or value in (".", "..") or any(
            c in value for c in ("/", "\\", "\x00")):
        raise ValueError(f"Invalid task path component: {value!r}")
    return value


def number(config, key, default, integer=False):
    raw = config.get(key, default)
    value = float(raw)
    if not math.isfinite(value) or value <= 0 or (integer and value != int(value)):
        raise ValueError(f"{key} must be a positive {'integer' if integer else 'number'}")
    return int(value) if integer else value


def settings(req):
    b = req["benchmark"]
    c = b["config"]
    unknown = set(c) - CONFIG
    if unknown:
        raise ValueError(f"Unknown LongDS config: {', '.join(sorted(unknown))}")
    root = Path(b["path"]).resolve()
    dataset = Path(c.get("dataset", str(root / "dataset"))).expanduser().resolve()
    version = component(c.get("version", "v1.1"))
    split = c.get("split", "lite")
    if split not in ("lite", "full"):
        raise ValueError("split must be lite or full")
    task_root = dataset / "task" / f"longds_{version}"
    return root, dataset, version, split, task_root


def catalog(req):
    root, dataset, version, split, task_root = settings(req)
    entries = read(task_root / f"task_list_{split}.json")
    if not isinstance(entries, list) or not entries:
        raise ValueError("Task list must be a nonempty JSON array (no version/split fallback)")
    seen = set()
    for entry in entries:
        tid = "/".join(component(entry[k]) for k in IDENTITY)
        if tid in seen:
            raise ValueError(f"Duplicate task: {tid}")
        seen.add(tid)
    return root, dataset, version, split, task_root, entries


def validate_turns(turns):
    if not isinstance(turns, list) or not turns:
        raise ValueError("Task must contain a nonempty array of turns")
    ids = []
    for i, turn in enumerate(turns, 1):
        if not isinstance(turn, dict) or not isinstance(turn.get("question"), str):
            raise ValueError(f"Turn {i} has no question")
        if not isinstance(turn.get("context", ""), str):
            raise ValueError(f"Turn {i} context is not text")
        if "answer" not in turn or turn["answer"] is None or turn["answer"] == "":
            raise ValueError(f"Turn {i} has no reference answer")
        tid = turn.get("turn_id", i)
        if type(tid) is not int or tid < 1 or tid in ids:
            raise ValueError(f"Invalid or duplicate turn_id: {tid!r}")
        ids.append(tid)
    return ids


def tasks(req):
    _, dataset, version, split, task_root, entries = catalog(req)
    out = []
    for entry in entries:
        tid = "/".join(entry[k] for k in IDENTITY)
        problems = []
        count = 0
        try:
            count = len(validate_turns(read(task_root / tid / "task.json")))
        except (OSError, ValueError, TypeError, KeyError) as exc:
            problems.append(str(exc))
        data = dataset / "data" / "longds" / tid / "data"
        if not data.is_dir() or not any(data.iterdir()):
            problems.append(f"Missing task data: {data}")
        out.append({"id": tid, "title": tid, "supported": not problems,
                    "reason": "; ".join(problems) or None,
                    "tags": {"domain": entry["task_domain"], "version": version,
                             "split": split, "turns": str(count)}})
    return {"tasks": out, "metrics": METRICS}


def solve(req):
    trial = req["trial"]
    if trial.get("options"):
        raise ValueError("LongDS has no trial options; configure version/split at registration")
    root, dataset, version, split, task_root, entries = catalog(req)
    task = trial["task"]
    index = next((i for i, e in enumerate(entries)
                  if "/".join(e[k] for k in IDENTITY) == task), None)
    if index is None:
        raise ValueError(f"Task is not in the selected version/split: {task}")
    turns = read(task_root / task / "task.json")
    validate_turns(turns)
    data = dataset / "data" / "longds" / task / "data"
    if not data.is_dir() or not any(data.iterdir()):
        raise ValueError(f"Missing task data: {data}")
    c = req["benchmark"]["config"]
    method = trial["method"]
    agent = method["agent"]
    if agent not in (*RUNNERS, "empty", "oracle"):
        raise ValueError(f"Unsupported Agent: {agent}")
    if agent in RUNNERS:
        if not (root / "runners" / RUNNERS[agent]).is_file():
            raise ValueError(f"Native {agent} runner missing; update the DataMind checkout")
        if "image" not in c or not c["image"].strip():
            raise ValueError("Set image to a prepared LongDS analysis Docker image")
        effort = method.get("effort")
        allowed = (("none", "low", "medium", "high", "xhigh", "max") if agent == "codex"
                   else ("low", "medium", "high", "xhigh", "max", "auto"))
        if effort is not None and effort not in allowed:
            raise ValueError(f"Unsupported {agent} effort: {effort}")
    resources = {"cpus": number(c, "cpus", 4), "memGB": number(c, "memGB", 16), "gpus": 0}
    resources.update({k: v for k, v in (trial.get("resources") or {}).items()
                      if k != "timeoutMin"})
    if resources["gpus"] != 0:
        raise ValueError("Upstream LongDS CLI runner has no GPU allocation flag; request gpus=0")
    timeout = trial.get("timeoutMin") or number(c, "timeoutMin", 1440)
    plan = {"root": str(root), "version": version, "split": split, "task": task,
            "index": index, "tasks": entries, "turns": turns, "method": method,
            "data_root": str(dataset / "data" / "longds"), "resources": resources,
            "image": c.get("image"), "hostNetwork": trial["hostNetwork"],
            "turnTimeoutSec": number(c, "turnTimeoutSec", 3600, integer=True),
            "analysisPython": c.get("analysisPython", "/usr/local/bin/python")}
    staging = Path(trial["staging"])
    plan_path = staging / "longds-plan.json"
    write(plan_path, plan)
    return {"spec": {"backend": "process", "resources": resources, "timeoutMin": timeout,
                     "command": [c.get("python", "python3"), str(HERE / "runtime.py"),
                                 "solve", str(plan_path)],
                     "env": {"PYTHONDONTWRITEBYTECODE": "1"},
                     "hostNetwork": trial["hostNetwork"]}}


def verify(req):
    c = req["benchmark"]["config"]
    return {"spec": {"backend": "process", "resources": {"cpus": 1, "memGB": 2, "gpus": 0},
                     "timeoutMin": number(c, "judgeTimeoutMin", 120),
                     "command": [c.get("python", "python3"), str(HERE / "runtime.py"),
                                 "verify", req["solve"]["output"],
                                 str(number(c, "judgeWorkers", 4, integer=True)),
                                 str(number(c, "judgeRetries", 3, integer=True))],
                     "env": {"PYTHONDONTWRITEBYTECODE": "1"}}}


def score(req):
    files = [{"label": "Per-turn judge", "phase": "verify", "kind": "json",
              "path": "task/results_eval.json"},
             {"label": "Evaluation summary", "phase": "verify", "kind": "markdown",
              "path": "review.md"}]
    review = {"files": files}
    try:
        selection = read(Path(req["solve"]["output"]) / "selection.json")
        expected = validate_turns(selection["turns"])
        if selection["task"] != req["trial"]["task"]:
            raise ValueError("Saved task identity does not match the trial")
        result = read(Path(req["verify"]["output"]) / "task/results_eval.json")
        if not isinstance(result, list) or len(result) != len(expected) + 1:
            raise ValueError("Judge output does not cover every task turn")
        values = []
        items = []
        for tid, row in zip(expected, result[:-1]):
            if type(row.get("turn_id")) is not int or row["turn_id"] != tid:
                raise ValueError("Judge output turn IDs differ from the full task")
            judge = row["judge"]
            if not isinstance(judge, dict) or "error" not in judge:
                raise ValueError(f"Judge result is incomplete on turn {tid}")
            if judge.get("error") is not None:
                raise ValueError(f"Judge failed on turn {tid}: {judge['error']}")
            value = judge["score"]
            if type(value) is not int or value not in (0, 1):
                raise ValueError(f"Invalid binary judge score on turn {tid}")
            values.append(value)
            items.append({"criterion": f"Turn {tid}", "score": value, "maxScore": 1,
                          "reasoning": str(judge.get("reasoning", ""))})
        average = sum(values) / len(values)
        summary = result[-1]["summary"]
        if (summary["correct"] != sorted(t for t, v in zip(expected, values) if v == 1)
                or summary["incorrect"] != sorted(t for t, v in zip(expected, values) if v == 0)
                or type(summary["avg_score"]) not in (int, float)
                or not math.isclose(summary["avg_score"], average, rel_tol=0, abs_tol=1e-12)):
            raise ValueError("Judge summary disagrees with per-turn scores")
        review.update({"items": items, "details": {"version": selection["version"],
                       "split": selection["split"], "turns": str(len(expected)),
                       "agent": selection["method"]["agent"]}})
        return {"score": average, "maxScore": 1, "invalid": False, "issues": [], "review": review}
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return {"score": None, "maxScore": 1, "invalid": True,
                "issues": [f"LongDS evaluation: {exc}"], "review": review}


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
