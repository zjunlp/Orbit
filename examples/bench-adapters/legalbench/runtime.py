"""Run the original LegalBench evaluator in an independent container."""

import importlib.util
import json
import os
from pathlib import Path
import sys


def predictions(path, size):
    try:
        answers = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        answers = {}
    if not isinstance(answers, dict):
        answers = {}
    return [answers.get(str(i), "") if isinstance(answers.get(str(i), ""), str) else ""
            for i in range(size)]


def run(mode, input_dir="/input", solve_dir="/solve", output=None):
    output = Path(output or os.environ["ORBIT_OUTPUT"])
    item = json.loads((Path(input_dir) / "task.json").read_text())
    size = len(item["prompts"])
    if mode in ("empty", "oracle"):
        answers = item["answers"] if mode == "oracle" else [""] * size
        (output / "answers.json").write_text(json.dumps(dict(enumerate(answers)), ensure_ascii=False))
        return
    result = {"task": item["task"], "source": item["source"], "questions": size}
    try:
        loader = importlib.util.spec_from_file_location("legalbench_evaluation", Path(input_dir) / "evaluation.py")
        native = importlib.util.module_from_spec(loader)
        loader.loader.exec_module(native)
        generations = predictions(Path(solve_dir) / "answers.json", size)
        result["score"] = float(native.evaluate(item["task"], generations, item["answers"]))
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
    (output / "result.json").write_text(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    run(sys.argv[1])
