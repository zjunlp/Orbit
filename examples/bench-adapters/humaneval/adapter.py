#!/usr/bin/env -S python3 -B
"""HumanEval through Orbit adapter protocol 1 (C1 fixed input; docs/integration-categories.md).

Identity: openai/human-eval commit 312c5e5 data `HumanEval.jsonl.gz` (sha256 below), 164 problems. A trial is one
problem: the subject sees only the prompt (signature + docstring) and returns a completion; the verify Run executes
the upstream check program (`prompt + completion + test + check(entry_point)`, 3 s like `evaluate_functional_correctness`)
with no network. pass@1 per trial; seeds are repeated samples.

Methods: `oracle` (canonical solution), `empty` (empty completion), `external` (an OpenAI-compatible chat model:
config `model`, `baseUrl`; key from passEnv `OPENAI_API_KEY`; temperature from config, default 0).
"""

import gzip
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import invalid, main as protocol_main, valid  # noqa: E402

HERE = Path(__file__).resolve().parent
DATA = "HumanEval.jsonl.gz"
DATA_SHA256 = "b796127e635a67f93fb35c04f4cb03cf06f38c8072ee7cee8833d7bee06979ef"
UPSTREAM = "openai/human-eval@312c5e5532f0e0470bf47f77a6243e02a61da530"
IMAGE = "python:3.11-slim@sha256:e88e9763f943ec1834f992a4b51e0f24500486803e8bc534e5767af9ea65f6ce"
TIMEOUT_SEC = 3.0

CAPABILITIES = {
    "category": "fixed-input",
    "identity": {"id": "humaneval", "name": "HumanEval", "version": "312c5e5"},
    "domains": ["software"],
    "taxonomy": {
        "domains": ["software"], "taskTypes": ["implementation"],
        "modalities": ["text"], "interfaces": ["response"],
        "platforms": ["software-system"], "world": ["controlled"],
        "feedback": ["none"], "participants": [],
        "scoringEvidence": ["artifact"], "scoringMethods": ["execution-test"],
    },
    "profiles": ["generate", "exec-test"],
    "methods": ["oracle", "empty", "external"],
    "scoreKind": "binary",
    "rescore": "evidence",
    # The empty completion leaves the signature's body empty: a syntax error, so it fails every test.
    "calibration": {"empty": "min", "oracle": "max", "repeat": "exact"},
    "conditions": {
        "Source": UPSTREAM,
        "Data": f"{DATA} sha256 {DATA_SHA256[:16]}…",
        "Subject sees": "the prompt only (signature and docstring); tests and solution stay hidden",
        "Check": f"upstream check program, {TIMEOUT_SEC:g} s per problem, no network",
        "Metric": "pass@1 per trial; seeds are repeated samples",
    },
}


def problems(req):
    path = Path(req["benchmark"]["path"]) / DATA
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != DATA_SHA256:
        raise ValueError(f"{path} is not the pinned HumanEval data (sha256 differs)")
    return {p["task_id"]: p for p in map(json.loads, gzip.decompress(raw).decode().splitlines())}


def problem(req):
    p = problems(req).get(req["trial"]["task"])
    if p is None:
        raise ValueError(f"unknown task {req['trial']['task']}")
    return p


def tasks(req):
    rows = [{"id": k, "title": p["entry_point"], "supported": True, "reason": None, "tags": {"suite": "HumanEval"}}
            for k, p in problems(req).items()]
    return {"tasks": rows, "capabilities": CAPABILITIES,
            "metrics": [{"name": "pass", "label": "pass@1", "unit": "%", "primary": True}]}


def solve(req):
    t = req["trial"]
    p = problem(req)
    method = t["method"]
    agent = method["agent"]
    if agent not in ("oracle", "empty", "external"):
        raise ValueError("HumanEval (C1) evaluates a model's completion; CLI Agents are not a C1 subject")
    staging = Path(t["staging"]) / "solve"
    staging.mkdir(parents=True, exist_ok=True)
    visible = {"task_id": p["task_id"], "prompt": p["prompt"]}
    if agent == "oracle":
        visible["completion"] = p["canonical_solution"]
    (staging / "problem.json").write_text(json.dumps(visible))
    spec = {
        "image": IMAGE,
        "command": ["python", "/orbit-adapter/subject.py", agent, "/orbit-adapter/problem.json"],
        "mounts": [{"source": str(HERE / "subject.py"), "target": "/orbit-adapter/subject.py", "mode": "ro"},
                   {"source": str(staging / "problem.json"), "target": "/orbit-adapter/problem.json", "mode": "ro"}],
        "resources": {"cpus": 1, "memGB": 1, "gpus": 0},
        "network": agent == "external",
        "timeoutMin": t.get("timeoutMin") or 5,
    }
    if agent == "external":
        cfg = method.get("config") or {}
        if not cfg.get("model") or not cfg.get("baseUrl"):
            raise ValueError("external methods need config model and baseUrl (key: passEnv OPENAI_API_KEY)")
        spec["env"] = {"ORBIT_MODEL": cfg["model"], "ORBIT_BASE_URL": cfg["baseUrl"],
                       "ORBIT_TEMPERATURE": cfg.get("temperature", "0")}
    return {"spec": spec}


def verify(req):
    t = req["trial"]
    p = problem(req)
    staging = Path(t["staging"]) / "verify"
    staging.mkdir(parents=True, exist_ok=True)
    (staging / "problem.json").write_text(json.dumps(p))
    return {"spec": {
        "image": IMAGE,
        "command": ["python", "/orbit-adapter/check.py", "/orbit-adapter/problem.json", "/solve/completion.json",
                    str(TIMEOUT_SEC)],
        "mounts": [{"source": str(HERE / "check.py"), "target": "/orbit-adapter/check.py", "mode": "ro"},
                   {"source": str(staging / "problem.json"), "target": "/orbit-adapter/problem.json", "mode": "ro"},
                   {"source": req["solve"]["output"], "target": "/solve", "mode": "ro"}],
        "network": False, "resources": {"cpus": 1, "memGB": 1, "gpus": 0}, "timeoutMin": 2,
    }}


def score(req):
    out = Path(req["verify"]["output"]) / "result.json"
    review = {"files": [{"label": "Completion", "phase": "solve", "kind": "json", "path": "completion.json"},
                        {"label": "Check", "phase": "verify", "kind": "json", "path": "result.json"}],
              "items": [], "details": {}}
    try:
        r = json.loads(out.read_text())
    except (OSError, ValueError):
        # No completion (the subject failed to answer) is the method's 0; a missing check result is not.
        if not (Path(req["solve"]["output"]) / "completion.json").is_file():
            return invalid("model_unavailable", "the solve run produced no completion", review=review) \
                if req["trial"]["method"]["agent"] == "external" else invalid("scorer_error", "no completion",
                                                                               review=review)
        return invalid("scorer_error", "the check produced no result", review=review)
    if r.get("task_id") != req["trial"]["task"]:
        return invalid("scorer_error", "the check result is for another problem", review=review)
    review["details"] = {"result": r["result"]}
    return valid(1.0 if r["result"] == "passed" else 0.0, metrics={"pass": 100.0 if r["result"] == "passed" else 0.0},
                 review=review)


if __name__ == "__main__":
    sys.exit(protocol_main(tasks, solve, verify, score))
