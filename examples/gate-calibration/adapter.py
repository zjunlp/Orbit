#!/usr/bin/env -S python3 -B
"""Disposable gate calibration tasks. Real CLI solves, independent offline verification.

These arithmetic development fixtures do not measure benchmark capability. No scores or token
counts are injected: the chosen Agent writes an answer and Orbit collects its native usage.
"""
import json
from pathlib import Path
import sys

IMAGE = "python:3.11-slim@sha256:e88e9763f943ec1834f992a4b51e0f24500486803e8bc534e5767af9ea65f6ce"


def main(req):
    op = req["op"]
    if op == "tasks":
        return {
            "tasks": [{"id": f"sum-{i}", "title": f"Sum of squares {i}", "supported": True,
                       "reason": None, "tags": {}} for i in range(1, 7)],
            "capabilities": {"identity": {"id": "orbit-gate-calibration", "name": "Gate development calibration", "version": "1"},
                             "methods": ["cli"], "scoreKind": "binary", "rescore": "evidence",
                             "conditions": {"Purpose": "Development calibration only", "Image": IMAGE}},
        }
    trial = req["trial"]
    n = int(trial["task"].removeprefix("sum-")) * 7 + 13
    if op == "solve":
        return {"spec": {
            "image": IMAGE,
            "agentTask": {"instruction": f"Follow your global AGENTS.md instructions. Compute the sum of the squares of the integers from 1 through {n}. Write a JSON object with numeric key answer to $ORBIT_OUTPUT/answer.json. You may use Python. Then finish."},
            "resources": {"cpus": 1, "memGB": 2, "gpus": 0}, "timeoutMin": 3,
        }}
    if op == "verify":
        expected = n * (n + 1) * (2 * n + 1) // 6
        script = ("import json,os; from pathlib import Path; p=Path('/solve/answer.json'); "
                  "answer=json.loads(p.read_text()).get('answer') if p.exists() else None; "
                  f"Path(os.environ['ORBIT_OUTPUT']+'/result.json').write_text(json.dumps({{'score':int(answer=={expected})}}))")
        return {"spec": {"image": IMAGE, "command": ["python", "-c", script],
                         "mounts": [{"source": req["solve"]["output"], "target": "/solve", "mode": "ro"}],
                         "network": False, "resources": {"cpus": 1, "memGB": 1, "gpus": 0}, "timeoutMin": 1}}
    if op == "score":
        p = Path(req["verify"]["output"]) / "result.json"
        if not p.is_file():
            return {"invalid": True, "score": None, "issues": ["verification output missing"]}
        return {"score": json.loads(p.read_text())["score"], "maxScore": 1}
    raise ValueError(f"Unknown operation {op}")


if __name__ == "__main__":
    print(json.dumps(main(json.load(sys.stdin))))
