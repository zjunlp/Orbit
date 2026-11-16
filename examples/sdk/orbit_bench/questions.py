"""Planning helpers for single-question adapters with private native grading inputs."""

import hashlib
import json
import math
from pathlib import Path
import shutil

from .batch import mount, run_spec, solve_batch, verify_input
from .protocol import invalid, valid


def checked_source(req, here):
    root = Path(req["benchmark"]["path"])
    pins = json.loads((here / "release.json").read_text())["files"]
    for name, digest in pins.items():
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest:
            raise ValueError(f"Upstream source changed: {name}")
    return pins


def dataset(req, default):
    cfg = req["benchmark"].get("config") or {}
    path = Path(cfg.get("data", str(Path(req["benchmark"]["path"]) / default)))
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if not cfg.get("dataSha256") or cfg["dataSha256"] != digest:
        raise ValueError("Set dataSha256 to the SHA-256 of the installed official dataset")
    rows = json.loads(raw) if raw.lstrip().startswith(b"[") else [json.loads(line) for line in raw.splitlines() if line.strip()]
    if not isinstance(rows, list) or not rows:
        raise ValueError("Expected a nonempty official dataset")
    return rows, digest


def solve_question(req, item, here):
    result = solve_batch(req, item, here)
    result["spec"]["mounts"].append(mount(Path(__file__).with_name("judged.py"), "/adapter/judged.py"))
    return result


def verify_question(req, item, here, judge):
    stage = verify_input(req, item)
    pins = checked_source(req, here)
    for name in pins:
        dest = stage / "native" / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path(req["benchmark"]["path"]) / name, dest)
    cfg = req["benchmark"].get("config") or {}
    (stage / "judge.json").write_text(json.dumps({"model": cfg.get("judgeModel", judge),
                                                "baseUrl": cfg.get("judgeBaseUrl"),
                                                "api": cfg.get("judgeApi", "chat"),
                                                "effort": cfg.get("judgeEffort", "low")}))
    spec = run_spec(req, stage, here)
    spec["mounts"].append(mount(Path(__file__).with_name("judged.py"), "/adapter/judged.py"))
    spec["mounts"].append(mount(req["solve"]["output"], "/solve"))
    spec.update({"command": ["python", "/adapter/runtime.py", "verify"],
                 "network": True, "timeoutMin": 15})
    return {"spec": spec}


def question_score(req):
    try:
        result = json.loads((Path(req["verify"]["output"]) / "result.json").read_text())
        if result["task"] != req["trial"]["task"]:
            raise ValueError("Result task differs from trial")
        if result.get("error"):
            return invalid(result.get("failure", "scorer_error"), result["error"])
        value = result["score"]
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError("Native score must be finite")
        return valid(value, review={"files": [
            {"label": "Answers", "phase": "solve", "kind": "json", "path": "answers.json"},
            {"label": "Native evaluation", "phase": "verify", "kind": "json", "path": "result.json"}]})
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return invalid("scorer_error", str(exc))
