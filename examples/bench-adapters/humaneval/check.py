"""Upstream HumanEval check (human_eval/execution.py check_correctness): no network, own process, timeout."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

problem = json.loads(Path(sys.argv[1]).read_text())
completion = json.loads(Path(sys.argv[2]).read_text())
timeout = float(sys.argv[3])
if completion.get("task_id") != problem["task_id"]:
    sys.exit("completion is for another problem")
program = (problem["prompt"] + completion["completion"] + "\n" + problem["test"] + "\n"
           + f"check({problem['entry_point']})")
with tempfile.TemporaryDirectory() as d:
    Path(d, "check.py").write_text(program)
    try:
        r = subprocess.run([sys.executable, "check.py"], cwd=d, capture_output=True, text=True, timeout=timeout)
        result = "passed" if r.returncode == 0 else "failed: " + (r.stderr.strip().splitlines() or ["error"])[-1][:200]
    except subprocess.TimeoutExpired:
        result = "timed out"
out = Path(os.environ.get("ORBIT_OUTPUT", "."))
(out / "result.json").write_text(json.dumps({"task_id": problem["task_id"], "result": result}))
