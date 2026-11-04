"""Validate saved MobileWorld original scores; no independent regrade."""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys


def read(path):
    return json.loads(Path(path).read_text())


def write(path, value):
    Path(path).write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False))



def redact_text_artifacts(root, secrets):
    values = sorted({value for value in secrets if value}, key=len, reverse=True)
    if not values:
        return
    text_suffixes = {".json", ".jsonl", ".txt", ".log", ".md", ".html", ".csv", ".yaml", ".yml"}
    for path in Path(root).rglob("*"):
        if path.is_file() and not path.is_symlink() and path.suffix.lower() in text_suffixes:
            text = path.read_text(encoding="utf-8")
            for value in values:
                text = text.replace(value, "[REDACTED]")
            path.write_text(text, encoding="utf-8")


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def original_score(text):
    match = re.fullmatch(r"score: ([^\n]+)\nreason: ([\s\S]*)", text)
    if not match:
        raise ValueError("Missing original score/reason")
    score = float(match[1])
    if not math.isfinite(score) or not 0 <= score <= 1:
        raise ValueError("Original score must be finite and within [0,1]")
    return score



def trajectory_review(task, rows):
    return {"version": 1, "goal": rows[0].get("task_goal", ""),
            "steps": [{"step": i, "screenshot": f"native/{task}/screenshots/{task}-0-{i + 1}.png",
                       "action": None if i == 0 else json.dumps(rows[i - 1]["action"], ensure_ascii=False, sort_keys=True),
                       "reward": None} for i in range(len(rows))],
            "stopReason": "Original screenshots precede actions; the final action has no captured resulting frame. See the original trajectory and score."}


def validate(root):
    root = Path(root)
    result, plan = read(root / "result.json"), read(root / "plan.json")
    if result.get("status") != "completed":
        raise ValueError(f"Episode incomplete: {result.get('failure', 'missing result')}")
    if plan.get("schema") != 1 or plan.get("source") != "a026188705f4a494a12d14ddab3786a23fd2c537":
        raise ValueError("Unknown source/version")
    task = plan["task"]
    if not re.fullmatch(r"[A-Za-z_]\w*", task):
        raise ValueError("Invalid task identity")
    native = root / "native" / task
    trajectory = read(native / "traj.json")
    if set(trajectory) != {"0"}:
        raise ValueError("Expected exactly one native task trajectory")
    rows = trajectory["0"]["traj"]
    if not rows or len(rows) > plan["max_steps"] or any(row["step"] != i for i, row in enumerate(rows, 1)):
        raise ValueError("Invalid native step sequence")
    if result.get("initializations") != 1 or result.get("evaluations") != 1:
        raise ValueError("Expected one episode and one final evaluation")
    score = original_score((native / "result.txt").read_text())
    if result.get("score") != score or result.get("steps") != len(rows):
        raise ValueError("Native score/steps disagree")
    required = {"plan.json", f"native/{task}/traj.json", f"native/{task}/result.txt"}
    for i in range(1, len(rows) + 1):
        required.add(f"native/{task}/screenshots/{task}-0-{i}.png")
    required.add("trajectory-review.json")
    if read(root / "trajectory-review.json") != trajectory_review(task, rows):
        raise ValueError("GUI view disagrees with original frame timing")
    hashes = result["sha256"]
    if set(hashes) != required or any(digest(root / name) != hashes[name] for name in required):
        raise ValueError("Saved evidence changed or is incomplete")
    terminated = rows[-1]["action"]["action_type"] in {"finished", "answer", "unknown", "error_env"}
    return {"valid": True, "score": score, "steps": len(rows), "terminated": terminated, "sha256": hashes}


if __name__ == "__main__":
    try:
        write(Path(os.environ["ORBIT_OUTPUT"]) / "validation.json", validate(sys.argv[1]))
    except Exception as error:
        write(Path(os.environ["ORBIT_OUTPUT"]) / "validation.json", {"valid": False, "error": type(error).__name__})
        sys.exit(1)
