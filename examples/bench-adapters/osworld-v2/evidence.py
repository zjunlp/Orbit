"""Validate saved original OSWorld results without resetting or regrading the VM."""
import hashlib
import json
import math
import os
from pathlib import Path
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



def trajectory_review(goal, rows):
    steps = [{"step": 0, "screenshot": "native/initial.png", "action": None, "reward": None}]
    pending = []
    for row in rows:
        action = row.get("action")
        pending.append(action if isinstance(action, str) else json.dumps(action, ensure_ascii=False, sort_keys=True))
        if row.get("screenshot_file"):
            steps.append({"step": len(steps), "screenshot": "native/" + row["screenshot_file"],
                          "action": "\n".join(pending), "reward": row.get("reward"), "terminated": bool(row.get("done"))})
            pending = []
    tail = " Uncaptured final actions remain in the original trajectory." if pending else ""
    return {"version": 1, "goal": goal, "steps": steps,
            "stopReason": "Saved native frames; actions between screenshots are grouped." + tail}


def validate(root):
    root = Path(root)
    result, plan = read(root / "result.json"), read(root / "plan.json")
    if result.get("status") != "completed":
        raise ValueError(f"Episode incomplete: {result.get('failure', 'missing result')}")
    if plan.get("schema") != 1 or plan.get("source") != "d9953673daf55381237e058fd9388cc2d74c5538" or plan.get("release") != "osworld-v2.1":
        raise ValueError("Unknown source/release")
    if result.get("resets") != 1 or result.get("evaluations") != 1:
        raise ValueError("Expected one episode and final evaluation")
    rows = [json.loads(line) for line in (root / "native/traj.jsonl").read_text().splitlines()]
    if not rows or rows[0]["step_num"] != 1 or any(type(row["step_num"]) is not int for row in rows):
        raise ValueError("Missing original action steps")
    steps = [row["step_num"] for row in rows]
    if any(b not in (a, a + 1) for a, b in zip(steps, steps[1:])) or not 1 <= steps[-1] <= plan["max_steps"]:
        raise ValueError("Invalid original step sequence/budget")
    score = float((root / "native/result.txt").read_text().strip())
    if not math.isfinite(score) or not 0 <= score <= 1 or score != result["score"]:
        raise ValueError("Invalid/disagreeing original score")
    required = {"plan.json", "native/result.txt", "native/traj.jsonl", "native/initial.png", "native/initial-goal.json", "trajectory-review.json"}
    if read(root / "trajectory-review.json") != trajectory_review(read(root / "native/initial-goal.json"), rows):
        raise ValueError("GUI view disagrees with native observations")
    if (root / "native/result.json").is_file():
        details = read(root / "native/result.json")
        if type(details.get("score")) not in (int, float) or details["score"] != score:
            raise ValueError("Original evaluator details disagree")
        required.add("native/result.json")
    for row in rows:
        path = row.get("screenshot_file")
        if path:
            if not isinstance(path, str) or Path(path).name != path or not path.endswith(".png"):
                raise ValueError("Invalid original screenshot path")
            required.add("native/" + path)
    if result["steps"] != steps[-1] or type(result["terminated"]) is not bool or result["terminated"] != bool(rows[-1].get("done")):
        raise ValueError("Episode summary disagrees")
    hashes = result["sha256"]
    if set(hashes) != required or any(digest(root / name) != hashes[name] for name in required):
        raise ValueError("Saved evidence changed or is incomplete")
    return {"valid": True, "score": score, "steps": steps[-1], "terminated": result["terminated"], "sha256": hashes}


if __name__ == "__main__":
    try:
        write(Path(os.environ["ORBIT_OUTPUT"]) / "validation.json", validate(sys.argv[1]))
    except Exception as error:
        write(Path(os.environ["ORBIT_OUTPUT"]) / "validation.json", {"valid": False, "error": type(error).__name__})
        sys.exit(1)
