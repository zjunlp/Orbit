"""Run planning for independent, file-based batches of text questions."""

import json
from pathlib import Path
import shlex


def mount(source, target):
    return {"source": str(source), "target": target, "mode": "ro"}


def run_spec(req, stage, adapter_dir):
    config = req["benchmark"].get("config") or {}
    return {**({"image": config["image"]} if config.get("image")
              else {"dockerfile": str(adapter_dir / "Dockerfile")}),
            "mounts": [mount(adapter_dir / "runtime.py", "/adapter/runtime.py"), mount(stage, "/input")],
            "resources": {"cpus": 1, "memGB": 2, "gpus": 0},
            "env": {"PYTHONDONTWRITEBYTECODE": "1"}, "network": False, "workdir": "/tmp"}


def solve_batch(req, item, adapter_dir):
    trial = req["trial"]
    stage = Path(trial["staging"]) / "solve"
    stage.mkdir(parents=True, exist_ok=True)
    visible = {k: item[k] for k in ("task", "prompts", "source")}
    method = trial["method"]
    if method["agent"] == "oracle":
        visible["answers"] = item["answers"]
    (stage / "task.json").write_text(json.dumps(visible, ensure_ascii=False))
    run = run_spec(req, stage, adapter_dir)
    run["collect"] = ["/input/task.json"]
    run["timeoutMin"] = trial.get("timeoutMin") or 30
    if method["agent"] in ("empty", "oracle"):
        run["command"] = ["python", "/adapter/runtime.py", method["agent"]]
    elif method["agent"] == "external":
        run["command"] = shlex.split(method["entrypoint"])
        if not run["command"] or not run["command"][0]:
            raise ValueError("External entrypoint must contain an executable")
        run["env"].update({"ORBIT_TASK_FILE": "/input/task.json",
                            "ORBIT_METHOD_CONFIG": json.dumps(method.get("config") or {})})
        run["network"] = True
    else:
        run["agentTask"] = {"instruction": (
            "Answer every prompt in /input/task.json independently, using only its provided text. "
            "Write $ORBIT_OUTPUT/answers.json as a JSON object mapping each question id to its answer string. "
            "Follow the original answer format. Do not include explanations unless requested by the prompt. "
            "Missing or malformed answers receive zero credit."
        )}
    return {"spec": run}


def verify_input(req, item):
    saved = json.loads((Path(req["solve"]["output"]) / "collected/input/task.json").read_text())
    if saved["source"] != item["source"] or saved["prompts"] != item["prompts"]:
        raise ValueError("Benchmark inputs changed since solve; restore the original test data and prompts")
    stage = Path(req["trial"]["staging"]) / "verify"
    stage.mkdir(parents=True, exist_ok=True)
    (stage / "task.json").write_text(json.dumps(item, ensure_ascii=False))
    return stage
