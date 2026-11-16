"""Native judge execution shared by the HealthBench and LongMemEval containers."""

import importlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import threading
import types


def prediction(path):
    try:
        values = json.loads(Path(path).read_text())
        value = values.get("0", "") if isinstance(values, dict) else ""
        return value if isinstance(value, str) else ""
    except (OSError, ValueError):
        return ""


def load_health(root):
    package = types.ModuleType("native_health")
    package.__path__ = [str(root)]
    sys.modules[package.__name__] = package
    return importlib.import_module("native_health.healthbench_eval")


def load_longmem(root):
    spec = importlib.util.spec_from_file_location("native_longmem", root / "src/evaluation/evaluate_qa.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def health_grade(native, item, response, complete):
    response_type = importlib.import_module("native_health.types").SamplerResponse
    judge = native.HealthBenchEval.__new__(native.HealthBenchEval)
    judge.length_adjustment_center = None
    judge.length_adjustment_penalty_per_500_chars = None
    lock = threading.Lock()
    calls = 0

    def sample(messages):
        nonlocal calls
        with lock:
            calls += 1
            if calls > len(item["rubrics"]) * 3:
                raise RuntimeError("Native rubric judge exceeded bounded response retries")
        return response_type(response_text=complete(messages), actual_queried_message_list=messages,
                             response_metadata={})

    judge.grader_model = sample
    metrics, _, grades = judge.grade_sample(item["prompt"], response, item["example_tags"],
                                           [native.RubricItem.from_dict(r) for r in item["rubrics"]])
    return {"score": metrics["overall_score"], "metrics": metrics, "rubricGrades": grades}


def run(kind, mode, input_dir="/input", solve_dir="/solve", output=None, complete=None):
    output = Path(output or os.environ["ORBIT_OUTPUT"])
    root = Path(input_dir)
    task = json.loads((root / "task.json").read_text())
    if mode in ("empty", "oracle"):
        value = task["answers"][0] if mode == "oracle" else ""
        (output / "answers.json").write_text(json.dumps({"0": value}))
        return
    result = {"task": task["task"], "source": task["source"]}
    try:
        config = json.loads((root / "judge.json").read_text())
        result["judge"] = config
        if complete is None:
            from openai import OpenAI
            client = OpenAI(api_key=os.environ["ORBIT_JUDGE_API_KEY"], base_url=config.get("baseUrl"),
                            max_retries=1, timeout=45)

            def complete(messages):
                if config.get("api") == "responses":
                    response = client.responses.create(model=config["model"], input=messages,
                        reasoning={"effort": config["effort"]}, max_output_tokens=4096).output_text
                    if not isinstance(response, str) or not response.strip():
                        raise RuntimeError("Judge returned no text")
                    return response
                kwargs = {"model": config["model"], "messages": messages, "temperature": 0.5 if kind == "healthbench" else 0,
                          "max_tokens": 2048 if kind == "healthbench" else 10}
                if kind == "healthbench":
                    kwargs["messages"] = [{"role": "system", "content": "You are a helpful assistant."}] + messages
                response = client.chat.completions.create(**kwargs).choices[0].message.content
                if not isinstance(response, str) or not response.strip():
                    raise RuntimeError("Judge returned no text")
                return response

        answer = prediction(Path(solve_dir) / "answers.json")
        native = task["native"]
        if kind == "healthbench":
            result.update(health_grade(load_health(root / "native"), native, answer, complete))
        else:
            evaluator = load_longmem(root / "native")
            prompt = evaluator.get_anscheck_prompt(native["question_type"], native["question"], native["answer"],
                                                   answer, abstention="_abs" in native["question_id"])
            judgment = complete([{"role": "user", "content": prompt}]).strip()
            result.update({"score": int("yes" in judgment.lower()), "judgment": judgment})
    except Exception as exc:
        detail = str(exc).replace(os.environ.get("ORBIT_JUDGE_API_KEY", "\0"), "[redacted]")[:1200]
        result.update({"error": f"{type(exc).__name__}: {detail}", "failure": "judge_unavailable"})
    (output / "result.json").write_text(json.dumps(result, allow_nan=False))
