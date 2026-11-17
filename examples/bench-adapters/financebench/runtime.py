"""Import human judgments only when bound to the exact submitted answer and task."""

import hashlib
import json
import os
from pathlib import Path
import sys


def prediction(path):
    try:
        data = json.loads(Path(path).read_text())
        answer = data.get("0", "") if isinstance(data, dict) else ""
        return answer if isinstance(answer, str) else ""
    except (OSError, ValueError):
        return ""


def run(mode, input_dir="/input", solve_dir="/solve", output=None):
    dest = Path(output or os.environ["ORBIT_OUTPUT"])
    item = json.loads((Path(input_dir) / "task.json").read_text())
    if mode in ("oracle", "empty"):
        (dest / "answers.json").write_text(json.dumps({"0": item["answers"][0] if mode == "oracle" else ""}))
        return
    answer = prediction(Path(solve_dir) / "answers.json")
    digest = hashlib.sha256(answer.encode()).hexdigest()
    result = {"task": item["task"], "source": item["source"], "answerSha256": digest}
    matches = [r for r in item["reviews"] if r.get("answer") == answer or r.get("answerSha256") == digest]
    if not answer.strip():
        result.update({"score": 0, "provenance": "No answer submitted"})
    elif matches and len({r["score"] for r in matches}) == 1:
        result.update({"score": matches[0]["score"], "provenance": [r["provenance"] for r in matches]})
    else:
        result.update({"error": "Missing or conflicting human judgment for this exact answer", "failure": "judge_unavailable"})
        (dest / "review-request.json").write_text(json.dumps({"task": item["task"], "source": item["source"],
            "answer": answer, "answerSha256": digest, "reviewer": "", "correct": None}, indent=2))
    (dest / "result.json").write_text(json.dumps(result))


if __name__ == "__main__":
    run(sys.argv[1])
