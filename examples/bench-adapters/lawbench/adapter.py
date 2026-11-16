#!/usr/bin/env -S python3 -B
"""LawBench zero-shot tasks and unmodified task-specific evaluation functions."""

import ast
import hashlib
import json
import math
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import invalid, main, valid  # noqa: E402
from orbit_bench.batch import mount, run_spec, solve_batch, verify_input  # noqa: E402

HERE = Path(__file__).resolve().parent
RELEASE = json.loads((HERE / "release.json").read_text())
REVISION = RELEASE["revision"]


def checked(req, path):
    raw = (Path(req["benchmark"]["path"]) / path).read_bytes()
    digest = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
    if digest != RELEASE["files"][path]:
        raise ValueError(f"{path} differs from LawBench {REVISION}")
    return raw


def functions(req):
    tree = ast.parse(checked(req, "evaluation/main.py"))
    mapping = next(n.value for n in ast.walk(tree) if isinstance(n, ast.Assign)
                   and any(isinstance(t, ast.Name) and t.id == "funct_dict" for t in n.targets))
    return {ast.literal_eval(k): (v.value.id, v.attr) for k, v in zip(mapping.keys, mapping.values)}


def tasks(req):
    root = Path(req["benchmark"]["path"])
    rows = []
    for name, (module, _) in functions(req).items():
        reason = None
        if name == "2-1":
            reason = "ChERRANT grammar correction needs an additional LTP model and writable native toolchain; not integrated."
        elif not (root / f"data/zero_shot/{name}.json").is_file():
            reason = "Missing original zero-shot test data."
        elif not (root / f"evaluation/evaluation_functions/{module}.py").is_file():
            reason = "Missing native evaluation module."
        rows.append({"id": name, "title": f"LawBench {name}: {module}", "supported": reason is None,
                     "reason": reason, "tags": {"suite": name.split("-")[0]}})
    return {"tasks": rows, "capabilities": {
        "identity": {"id": "lawbench", "name": "LawBench", "version": REVISION, "variant": "zero-shot"},
        "taxonomy": {"domains": ["law-public-affairs"], "taskTypes": ["answering", "information-processing"],
                     "targets": ["knowledge", "reasoning"], "modalities": ["text"], "interfaces": ["response"],
                     "platforms": ["software-system"], "world": ["controlled"], "feedback": ["none"],
                     "participants": [], "scoringEvidence": ["response"], "scoringMethods": ["rule-check"]},
        "methods": ["cli", "external", "oracle", "empty"], "scoreKind": "scalar", "rescore": "score",
        "calibration": {"oracle": {"min": 0.9999999, "max": 1}},
        "conditions": {"Unit": "Complete zero-shot task test set", "Language": "Chinese",
                       "Scoring": "Native functions selected from evaluation/main.py; no metric replacement",
                       "Oracle": "Reference replay; native metrics and dataset defects can prevent full marks",
                       "Harness": "Orbit batch file submission; original instructions and questions"},
    }}


def problem(req):
    name = req["trial"]["task"]
    row = next((r for r in tasks(req)["tasks"] if r["id"] == name), None)
    if row is None or not row["supported"]:
        raise ValueError(row["reason"] if row else f"Unknown LawBench task {name}")
    raw = checked(req, f"data/zero_shot/{name}.json")
    rows = json.loads(raw)
    if not isinstance(rows, list) or not rows:
        raise ValueError("Expected a nonempty original LawBench question list")
    module, function = functions(req)[name]
    return {"task": name, "prompts": [{"id": str(i), "prompt": r["instruction"] + "\n" + r["question"]}
                                       for i, r in enumerate(rows)],
            "answers": [r["answer"].replace("\u7b54\u6848:", "") if name == "1-1" else r["answer"] for r in rows],
            "references": [r["answer"] for r in rows], "function": [module, function],
            "source": {"revision": REVISION, "variant": "zero-shot", "dataSha256": hashlib.sha256(raw).hexdigest()}}


def solve(req):
    return solve_batch(req, problem(req), HERE)


def verify(req):
    stage = verify_input(req, problem(req))
    for path in RELEASE["files"]:
        if not path.startswith("evaluation/"):
            continue
        dest = stage / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(checked(req, path))
    run = run_spec(req, stage, HERE)
    run["mounts"].append(mount(req["solve"]["output"], "/solve"))
    run.update({"command": ["python", "/adapter/runtime.py", "verify"], "timeoutMin": 5})
    return {"spec": run}


def score(req):
    try:
        result = json.loads((Path(req["verify"]["output"]) / "result.json").read_text())
        if result["task"] != req["trial"]["task"]:
            raise ValueError("Result belongs to another task")
        if result.get("error"):
            return invalid("scorer_error", result["error"])
        value = result["score"]
        if not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError("Native score is not finite")
        return valid(value, review={"files": [
            {"label": "Answers", "phase": "solve", "kind": "json", "path": "answers.json"},
            {"label": "Native evaluation", "phase": "verify", "kind": "json", "path": "result.json"}],
            "details": {"unit": "complete zero-shot task", "source": REVISION}})
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return invalid("scorer_error", f"Missing or invalid native result: {exc}")


if __name__ == "__main__":
    sys.exit(main(tasks, solve, verify, score))
