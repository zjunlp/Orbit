"""Validate saved live rewards; this is not a replay or an independent task regrade."""

import hashlib
import json
import math
import os
from pathlib import Path
import sys

BROWSERGYM_VERSION = "0.14.3"
MINIWOB_COMMIT = "7fd85d71a4b60325c6585396ec4f48377d049838"


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write(path, value):
    Path(path).write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False),
                          encoding="utf-8")


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def trajectory_review(rows, result):
    return {"version": 1, "goal": rows[0].get("goal", ""),
            "steps": [{"step": row["step"], "screenshot": row["screenshot"],
                       "action": row["action"], "reward": row["reward"],
                       "actionError": row.get("last_action_error") or "",
                       "terminated": row["terminated"], "truncated": row["truncated"],
                       "observation": row.get("axtree_txt", "")} for row in rows],
            "stopReason": result.get("stop_reason") or
            f"{result.get('error_stage', 'unknown')}: {result.get('error_type', 'incomplete')}"}


def validate(root):
    result = read(root / "result.json")
    if result.get("status") != "completed":
        raise ValueError(f"Episode did not complete: {result.get('error_stage', 'unknown stage')}: "
                         f"{result.get('error_type', 'missing status')}")
    plan = read(root / "plan.json")
    if (plan.get("schema") != 1 or plan.get("browsergym_version") != BROWSERGYM_VERSION
            or plan.get("miniwob_commit") != MINIWOB_COMMIT):
        raise ValueError("Unknown evidence schema or environment version")
    if plan.get("action_set") not in ("coord", "bid") or not 1 <= plan["max_steps"] <= 1000:
        raise ValueError("Invalid episode budget/action set")
    rows = [json.loads(line) for line in (root / "trajectory.jsonl").read_text().splitlines()]
    steps = result["steps"]
    if type(steps) is not int or not 1 <= steps <= plan["max_steps"] or len(rows) != steps + 1:
        raise ValueError("Trajectory is incomplete or exceeds the step budget")
    required = {"plan.json", "trajectory.jsonl"}
    for i, row in enumerate(rows):
        path = f"screenshots/{i:04d}.png"
        required.add(path)
        if row["step"] != i or row["screenshot"] != path:
            raise ValueError("Trajectory observations are missing or out of order")
        if row["reward"] not in (0, 1) or type(row["reward"]) not in (int, float):
            raise ValueError("Invalid official binary reward")
        if type(row["terminated"]) is not bool or type(row["truncated"]) is not bool:
            raise ValueError("Missing episode termination flags")
        if i < steps and (row["terminated"] or row["truncated"]):
            raise ValueError("Trajectory continued after termination")
        if i and (not isinstance(row["action"], str) or not row["action"]):
            raise ValueError("Missing action")
        if i:
            info = row["task_info"]
            if info.get("error") in ("invalid page, terminating task", "invalid url, terminating task"):
                if row["reward"] != 0 or not row["terminated"]:
                    raise ValueError("Leaving the task page must terminate with original zero reward")
            else:
                raw = info["RAW_REWARD_GLOBAL"]
                if type(raw) not in (int, float) or not math.isfinite(raw):
                    raise ValueError("Missing original MiniWoB reward")
                if row["reward"] != float(raw > 0):
                    raise ValueError("Reward disagrees with BrowserGym's original MiniWoB rule")
    if type(result["reward"]) not in (int, float) or result["reward"] != rows[-1]["reward"]:
        raise ValueError("Final reward disagrees with the trajectory")
    reason = result["stop_reason"]
    if reason == "terminated":
        if not (rows[-1]["terminated"] or rows[-1]["truncated"]):
            raise ValueError("Episode claims termination without evidence")
    elif reason == "max_steps":
        if steps != plan["max_steps"]:
            raise ValueError("Episode ended before its step budget")
    elif reason in ("agent_stop", "empty"):
        if rows[-1]["action"] != "noop()":
            raise ValueError("Stop action is not a noop")
        if reason == "empty" and (plan["method"]["agent"] != "empty" or steps != 1):
            raise ValueError("Empty calibration is not a single noop")
    else:
        raise ValueError("Unknown episode end reason")
    hashes = result["sha256"]
    if (root / "trajectory-review.json").is_file():
        required.add("trajectory-review.json")
        if read(root / "trajectory-review.json") != trajectory_review(rows, result):
            raise ValueError("Trajectory review disagrees with the recorded observations")
    if set(hashes) != required or any(digest(root / name) != hashes[name] for name in required):
        raise ValueError("Saved evidence is missing or changed")
    return {"valid": True, "reward": result["reward"], "steps": steps,
            "evidence": "live BrowserGym reward", "sha256": hashes}


if __name__ == "__main__":
    try:
        report = validate(Path(sys.argv[1]))
        write(Path(os.environ["ORBIT_OUTPUT"]) / "validation.json", report)
    except Exception as exc:
        write(Path(os.environ["ORBIT_OUTPUT"]) / "validation.json",
              {"valid": False, "error": f"{type(exc).__name__}: {exc}"})
        sys.exit(1)
