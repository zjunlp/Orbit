"""Independent native answer evaluation; audio is consumed only by the subject."""

import importlib.util
import json
import os
from pathlib import Path
import sys


def prediction(path):
    try:
        answers = json.loads(Path(path).read_text())
        value = answers.get("0", "") if isinstance(answers, dict) else ""
        return value if isinstance(value, str) else ""
    except (OSError, ValueError):
        return ""


def run(mode, input_dir="/input", solve_dir="/solve", output=None):
    output = Path(output or os.environ["ORBIT_OUTPUT"])
    item = json.loads((Path(input_dir) / "task.json").read_text())
    if mode in ("empty", "oracle"):
        answer = item["answers"][0] if mode == "oracle" else ""
        (output / "answers.json").write_text(json.dumps({"0": answer}))
        return
    result = {"task": item["task"], "source": item["source"]}
    try:
        loader = importlib.util.spec_from_file_location("mmau_evaluation", Path(input_dir) / "evaluation.py")
        native = importlib.util.module_from_spec(loader)
        loader.loader.exec_module(native)
        answer = prediction(Path(solve_dir) / "answers.json")
        result["score"] = int(native.string_match(item["answers"][0], answer, item["prompts"][0]["choices"]))
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
    (output / "result.json").write_text(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    run(sys.argv[1])
