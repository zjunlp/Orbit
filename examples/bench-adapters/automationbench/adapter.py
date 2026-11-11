#!/usr/bin/env -S python3 -B
"""Original AutomationBench agent, simulated APIs and rubric through Orbit."""

import hashlib
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "sdk"))
from orbit_bench import main, invalid, valid, pinned

REVISION = "4a8e1061254004d9dac807054eed33fad7d1ff14"
PUBLIC = {"sales", "marketing", "operations", "support", "finance", "hr"}


def settings(req):
    cfg = req["benchmark"].get("config", {})
    if set(cfg) - {"image", "catalogSha256", "split"}:
        raise ValueError("Only image, catalogSha256 and split are supported")
    if not pinned(cfg.get("image")):
        raise ValueError("image must be an immutable Docker image ID or digest")
    raw = (Path(req["benchmark"]["path"]) / "catalog.json").read_bytes()
    if hashlib.sha256(raw).hexdigest() != cfg.get("catalogSha256"):
        raise ValueError("Catalog digest mismatch; regenerate and register the pinned source")
    catalog = json.loads(raw)
    if catalog["revision"] != REVISION:
        raise ValueError("Unexpected AutomationBench source revision")
    split = cfg.get("split", "public")
    if split not in ("public", "simple"):
        raise ValueError("split must be public or simple (never combine their scores)")
    domains = PUBLIC if split == "public" else {"simple"}
    rows = [t for t in catalog["tasks"] if t["id"].split(".")[0] in domains]
    ids = [t["id"] for t in rows]
    if not rows or len(set(ids)) != len(ids):
        raise ValueError("Empty or duplicate task catalog")
    return cfg, rows


def tasks(req):
    cfg, entries = settings(req)
    return {"tasks": [{"id": e["id"], "title": e["id"], "supported": True, "reason": None,
                       "tags": {"suite": cfg.get("split", "public"), "domain": e["id"].split(".")[0]}}
                      for e in entries],
            "metrics": [{"name": "partial_credit", "label": "Assertions satisfied", "unit": "%",
                         "range": [0, 100], "higherIsBetter": True, "primary": False}],
            "capabilities": {
                "identity": {"id": "automationbench", "name": "AutomationBench", "version": "1.0.6",
                             "variant": cfg.get("split", "public")},
                "methods": ["empty", "external"], "scoreKind": "binary", "rescore": "score",
                "conditions": {"Source": REVISION, "Agent": "Unmodified auto-bench native tool agent; API toolset",
                               "Score": "Original strict task_completed_correctly; partial_credit reported separately",
                               "Split": cfg.get("split", "public") + "; official leaderboard uses private tasks",
                               "Seeds": "Trial repetition only; upstream UUID and clock behavior is unchanged",
                               "Oracle": "No upstream reference agent; empty is an unchanged native world, not always zero"}},
            "official": {"name": "AutomationBench " + cfg.get("split", "public") + " strict pass rate", "version": "1.0.6",
                         "unit": "task", "errors": "exclude"}}


def plan(req, phase):
    cfg, entries = settings(req)
    trial = req["trial"]
    entry = next((e for e in entries if e["id"] == trial["task"]), None)
    if entry is None:
        raise ValueError("Unknown task")
    method = trial["method"]
    if method["agent"] not in ("empty", "external"):
        raise ValueError("Use empty or external entrypoint=auto-bench; CLI wrappers change the native protocol")
    if method["agent"] == "external" and (method.get("entrypoint") != "auto-bench" or not method.get("model")):
        raise ValueError("External method requires entrypoint=auto-bench and model")
    options = method.get("config", {})
    if set(options) - {"baseUrl", "maxSteps"}:
        raise ValueError("Only baseUrl and maxSteps are supported native method settings")
    steps = int(options.get("maxSteps", 50))
    if not 1 <= steps <= 50:
        raise ValueError("maxSteps must be between 1 and the native default of 50")
    payload = {"task": entry["id"], "contract": entry["contract"], "domain": entry["id"].split(".")[0],
               "method": method["agent"], "model": method.get("model"), "effort": method.get("effort"),
               "baseUrl": options.get("baseUrl"), "maxSteps": steps}
    staging = Path(trial["staging"])
    staging.mkdir(parents=True, exist_ok=True)
    path = staging / (phase + ".json")
    path.write_text(json.dumps(payload))
    mounts = [{"source": str(HERE / "runtime.py"), "target": "/opt/orbit-adapter/runtime.py", "mode": "ro"},
              {"source": str(path), "target": "/plan.json", "mode": "ro"}]
    if phase == "verify":
        mounts.append({"source": req["solve"]["output"], "target": "/solve", "mode": "ro"})
    return {"spec": {"image": cfg["image"], "command": ["python", "/opt/orbit-adapter/runtime.py", phase],
                     "mounts": mounts, "network": phase == "solve" and method["agent"] == "external",
                     "env": {"AUTOMATIONBENCH_STRICT_ASSERTIONS": "1", "PYTHONDONTWRITEBYTECODE": "1"},
                     "resources": {"cpus": 2, "memGB": 4, "gpus": 0},
                     "timeoutMin": (trial.get("timeoutMin") or 20) if phase == "solve" else 5}}


def score(req):
    try:
        report = json.loads((Path(req["verify"]["output"]) / "verdict.json").read_text())
        if report.get("invalid"):
            return invalid("scorer_error", report.get("error", "Original evaluation failed"))
        cfg, entries = settings(req)
        entry = next(e for e in entries if e["id"] == req["trial"]["task"])
        raw = (Path(req["solve"]["output"]) / "native.json").read_bytes()
        if (report.get("task") != entry["id"] or report.get("contract") != entry["contract"]
                or report.get("revision") != REVISION
                or report.get("nativeSha256") != hashlib.sha256(raw).hexdigest()):
            raise ValueError("Evidence identity mismatch")
        if report["score"] not in (0, 1) or not 0 <= report["partial_credit"] <= 1:
            raise ValueError("Native score outside its range")
        return valid(report["score"], metrics={"partial_credit": 100 * report["partial_credit"]}, review={
            "files": [{"label": "Native tool conversation and world", "phase": "solve", "path": "native.json", "kind": "json"},
                      {"label": "Independent original rubric", "phase": "verify", "path": "verdict.json", "kind": "json"}],
            "details": {"Source": REVISION, "Split": cfg.get("split", "public")}})
    except (OSError, ValueError, KeyError, TypeError, StopIteration) as exc:
        return invalid("scorer_error", str(exc))


if __name__ == "__main__":
    sys.exit(main(tasks, lambda r: plan(r, "solve"), lambda r: plan(r, "verify"), score))
