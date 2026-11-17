"""Invoke the upstream LawBench function without exposing labels to the subject."""

import importlib
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
        values = item["answers"] if mode == "oracle" else [""] * size
        (output / "answers.json").write_text(json.dumps(dict(enumerate(values)), ensure_ascii=False))
        return
    result = {"task": item["task"], "source": item["source"], "questions": size}
    try:
        sys.path.insert(0, str(Path(input_dir) / "evaluation"))
        module, function = item["function"]
        native = getattr(importlib.import_module("evaluation_functions." + module), function)
        answers = predictions(Path(solve_dir) / "answers.json", size)
        rows = [{"origin_prompt": prompt["prompt"], "prediction": prediction, "refr": reference}
                for prompt, prediction, reference in zip(item["prompts"], answers, item["references"], strict=True)]
        native_result = native(rows)
        result.update({"score": float(native_result["score"]), "native": native_result})
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
    (output / "result.json").write_text(json.dumps(result, allow_nan=False))


if __name__ == "__main__":
    run(sys.argv[1])
