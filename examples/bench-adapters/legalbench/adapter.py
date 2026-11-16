#!/usr/bin/env -S python3 -B
"""LegalBench: a trial is a complete upstream task, preserving balanced accuracy and F1."""

import ast
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import invalid, main, valid  # noqa: E402
from orbit_bench.batch import mount, run_spec, solve_batch, verify_input  # noqa: E402

HERE = Path(__file__).resolve().parent
RELEASE = json.loads((HERE / "release.json").read_text())
REVISION = "b46bf4ffae90524b2b72aaa30e7745fe9db64481"
SOURCE_HASHES = {
    "tasks.py": "7c5e37a03d53fe878a2f3dcc149ab380d7533661",
    "evaluation.py": "6e6dd1d3bae4b2f4bdd39d41c9378f548b2e0236",
}
TAXONOMY = {
    "domains": ["law-public-affairs"], "taskTypes": ["answering", "information-processing"],
    "targets": ["reasoning"], "modalities": ["text"], "interfaces": ["response"],
    "platforms": ["software-system"], "world": ["controlled"], "feedback": ["none"],
    "participants": [], "scoringEvidence": ["response"], "scoringMethods": ["rule-check"],
}


def checked_bytes(req, name):
    raw = (Path(req["benchmark"]["path"]) / name).read_bytes()
    digest = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
    expected = SOURCE_HASHES[name] if name in SOURCE_HASHES else RELEASE["files"][name]
    if digest != expected:
        raise ValueError(f"{name} differs from LegalBench {REVISION}")
    return raw


def checked_source(req, name):
    return checked_bytes(req, name).decode()


def assignments(source):
    return {node.targets[0].id: ast.literal_eval(node.value)
            for node in ast.parse(source).body
            if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
            and isinstance(node.value, (ast.List, ast.Tuple))}


def catalog(req):
    names = assignments(checked_source(req, "tasks.py"))["TASKS"]
    manual = assignments(checked_source(req, "evaluation.py"))["MANUAL_EVAL_TASKS"]
    root = Path(req["benchmark"]["path"])
    result = []
    for name in names:
        reason = None
        if name in manual:
            reason = "The upstream evaluator requires human grading."
        elif not (root / "tasks" / name / "test.tsv").is_file():
            reason = "Missing official test.tsv; install the nguha/legalbench test data."
        elif not (root / "tasks" / name / "base_prompt.txt").is_file():
            reason = "Missing upstream base_prompt.txt."
        tags = {"suite": name}
        if name == "sara_numeric":
            tags["oracle"] = "partial"
        result.append({"id": name, "title": name.replace("_", " "), "supported": reason is None,
                       "reason": reason, "tags": tags})
    return result


def tasks(req):
    return {"tasks": catalog(req), "capabilities": {
        "identity": {"id": "legalbench", "name": "LegalBench", "version": REVISION},
        "taxonomy": TAXONOMY, "methods": ["cli", "external", "oracle", "empty"],
        "scoreKind": "scalar", "rescore": "score",
        "conditions": {"Unit": "One complete original task test set, not one question",
                       "Scoring": "Unmodified upstream evaluation.evaluate; task metrics differ",
                       "Prompt": "Original base_prompt.txt; CLI batch submission is an Orbit scaffold"},
    }}


def problem(req):
    name = req["trial"]["task"]
    row = next((r for r in catalog(req) if r["id"] == name), None)
    if row is None or not row["supported"]:
        raise ValueError(row["reason"] if row else f"Unknown task {name}")
    data = checked_bytes(req, f"tasks/{name}/test.tsv")
    template = checked_bytes(req, f"tasks/{name}/base_prompt.txt")
    rows = list(csv.DictReader(io.StringIO(data.decode("utf-8-sig")), delimiter="\t"))
    if not rows or any("answer" not in r for r in rows):
        raise ValueError("The test set must contain nonempty rows with an answer column")
    prompts = []
    for index, row in enumerate(rows):
        prompt = template.decode()
        # Same literal field substitution as upstream utils.generate_prompts.
        for key, value in row.items():
            if key != "answer":
                prompt = prompt.replace("{{" + key + "}}", str(value))
        if re.search(r"\{\{.*?\}\}", prompt):
            raise ValueError("Unresolved prompt fields (answer labels cannot be used in prompts)")
        prompts.append({"id": str(index), "prompt": prompt})
    return {"task": name, "prompts": prompts, "answers": [r["answer"] for r in rows],
            "source": {"revision": REVISION, "dataSha256": hashlib.sha256(data).hexdigest(),
                       "promptSha256": hashlib.sha256(template).hexdigest()}}


def solve(req):
    return solve_batch(req, problem(req), HERE)


def verify(req):
    stage = verify_input(req, problem(req))
    (stage / "evaluation.py").write_text(checked_source(req, "evaluation.py"))
    run = run_spec(req, stage, HERE)
    run["mounts"].append(mount(req["solve"]["output"], "/solve"))
    run.update({"command": ["python", "/adapter/runtime.py", "verify"], "timeoutMin": 5})
    return {"spec": run}


def score(req):
    try:
        result = json.loads((Path(req["verify"]["output"]) / "result.json").read_text())
        if result["task"] != req["trial"]["task"]:
            raise ValueError("Result task does not match trial")
        if result.get("error"):
            return invalid("scorer_error", result["error"])
        value = result["score"]
        if not isinstance(value, (int, float)) or not 0 <= value <= 1:
            raise ValueError("Native score is outside [0, 1]")
        return valid(value, review={"files": [
            {"label": "Answers", "phase": "solve", "kind": "json", "path": "answers.json"},
            {"label": "Native evaluation", "phase": "verify", "kind": "json", "path": "result.json"}],
            "details": {"unit": "complete task test set", "source": REVISION}})
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return invalid("scorer_error", f"Missing or invalid native result: {exc}")


if __name__ == "__main__":
    sys.exit(main(tasks, solve, verify, score))
