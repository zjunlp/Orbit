#!/usr/bin/env -S python3 -B
"""Chartography's original no-tools solver and independent native judge."""
import hashlib
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "sdk"))
from orbit_bench import main, invalid, valid, pinned

REVISION = "3f1bf837232d3918c2cc35c6e2418c9e70d2a57b"


def settings(req):
    cfg = req["benchmark"].get("config", {})
    allowed = {"image", "catalogSha256", "taskPack", "judgeModel", "judgeBaseUrl", "variant"}
    if set(cfg) - allowed:
        raise ValueError("Unknown Chartography configuration")
    if not pinned(cfg.get("image")):
        raise ValueError("image must be immutable")
    pack = Path(cfg.get("taskPack", ""))
    if not pack.is_absolute() or not (pack / "manifest.yaml").is_file():
        raise ValueError("taskPack must be an original local task pack with images and manifest.yaml")
    raw = (Path(req["benchmark"]["path"]) / "catalog.json").read_bytes()
    if hashlib.sha256(raw).hexdigest() != cfg.get("catalogSha256"):
        raise ValueError("Catalog digest mismatch")
    data = json.loads(raw)
    if data.get("revision") != REVISION:
        raise ValueError("Unexpected Chartography source")
    ids = [t["id"] for t in data["tasks"]]
    if not ids or len(set(ids)) != len(ids):
        raise ValueError("Empty or duplicate task catalog")
    if cfg.get("variant", "task-pack") not in ("sample", "task-pack"):
        raise ValueError("variant must be sample or task-pack; samples are not the released benchmark")
    return cfg, data


def tasks(req):
    cfg, data = settings(req)
    return {"tasks": [{"id": e["id"], "title": e["title"], "supported": True, "reason": None,
                       "tags": {"suite": cfg.get("variant", "task-pack"), "domain": e["domain"]}}
                      for e in data["tasks"]], "capabilities": {
        "identity": {"id": "chartography", "name": "Chartography", "version": REVISION,
                     "variant": cfg.get("variant", "task-pack")},
        "methods": ["external", "empty", "oracle"], "scoreKind": "binary", "rescore": "evidence",
        "calibration": {"empty": "any"},
        "conditions": {"Source": REVISION, "Solver": "Original Inspect generate() with chart attached inline; no tools",
                       "Judge": cfg.get("judgeModel", "google/gemini-3.5-flash"),
                       "Dataset": cfg.get("variant", "task-pack") + "; two bundled dummy samples are not the released set",
                       "Aggregation": "Per-task accuracy; official ten-epoch Pass@10/Pass^10 is not computed"}}}


def plan(req, phase):
    cfg, data = settings(req)
    trial = req["trial"]
    if trial["task"] not in {e["id"] for e in data["tasks"]}:
        raise ValueError("Unknown task")
    method = trial["method"]
    if method["agent"] not in ("empty", "oracle", "external"):
        raise ValueError("Use the native external Inspect solver; CLI agents change the no-tools protocol")
    if method["agent"] == "external" and (method.get("entrypoint") != "inspect" or not method.get("model")):
        raise ValueError("External method requires entrypoint=inspect and provider/model")
    options = method.get("config", {})
    if set(options) - {"baseUrl"}:
        raise ValueError("Only the native model baseUrl can be configured")
    payload = {"task": trial["task"], "method": method["agent"], "model": method.get("model"),
               "effort": method.get("effort"), "baseUrl": options.get("baseUrl"),
               "packSha256": data["packSha256"], "judgeModel": cfg.get("judgeModel", "google/gemini-3.5-flash")}
    staging = Path(trial["staging"])
    staging.mkdir(parents=True, exist_ok=True)
    path = staging / (phase + ".json")
    path.write_text(json.dumps(payload))
    mounts = [{"source": str(HERE / "runtime.py"), "target": "/opt/orbit-adapter/runtime.py", "mode": "ro"},
              {"source": str(path), "target": "/plan.json", "mode": "ro"},
              {"source": cfg["taskPack"], "target": "/pack", "mode": "ro"}]
    if phase == "verify":
        mounts.append({"source": req["solve"]["output"], "target": "/solve", "mode": "ro"})
    return {"spec": {"image": cfg["image"], "command": ["python", "/opt/orbit-adapter/runtime.py", phase],
                     "mounts": mounts, "network": phase == "verify" or method["agent"] == "external",
                     "env": {"PYTHONDONTWRITEBYTECODE": "1", **({"JUDGE_BASE_URL": cfg["judgeBaseUrl"]} if cfg.get("judgeBaseUrl") else {})},
                     "resources": {"cpus": 1, "memGB": 2, "gpus": 0},
                     "timeoutMin": (trial.get("timeoutMin") or 15) if phase == "solve" else 10}}


def score(req):
    try:
        cfg, data = settings(req)
        result = json.loads((Path(req["verify"]["output"]) / "verdict.json").read_text())
        if result.get("invalid"):
            return invalid("scorer_error", result.get("error", "Original judge failed"))
        raw = (Path(req["solve"]["output"]) / "response.json").read_bytes()
        if (result.get("task") != req["trial"]["task"] or result.get("packSha256") != data["packSha256"]
                or result.get("revision") != REVISION or result.get("responseSha256") != hashlib.sha256(raw).hexdigest()
                or result.get("judgeModel") != cfg.get("judgeModel", "google/gemini-3.5-flash")):
            raise ValueError("Evidence or judge identity mismatch")
        if type(result["score"]) not in (int, float) or result["score"] not in (0, 1):
            raise ValueError("Invalid native accuracy")
        return valid(result["score"], review={"files": [
            {"label": "Model response", "phase": "solve", "path": "response.json", "kind": "json"},
            {"label": "Original judge", "phase": "verify", "path": "verdict.json", "kind": "json"}],
            "details": {"Judge": result["judgeModel"], "Variant": cfg.get("variant", "task-pack")}})
    except (OSError, ValueError, TypeError, KeyError) as exc:
        return invalid("scorer_error", str(exc))


if __name__ == "__main__":
    sys.exit(main(tasks, lambda r: plan(r, "solve"), lambda r: plan(r, "verify"), score))
