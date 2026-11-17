#!/usr/bin/env -S python3 -B
"""FinanceBench open-source questions with explicit human grading, not an invented LLM metric."""

import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import main
from orbit_bench.batch import mount, run_spec, verify_input
from orbit_bench.questions import checked_source, question_score, solve_question

HERE = Path(__file__).resolve().parent
RELEASE = json.loads((HERE / "release.json").read_text())


def rows(req):
    checked_source(req, HERE)
    root = Path(req["benchmark"]["path"])
    return [json.loads(line) for line in (root / "data/financebench_open_source.jsonl").read_text().splitlines()]


def condition(req):
    value = (req["benchmark"].get("config") or {}).get("variant", "full-document")
    if value not in ("full-document", "oracle-context"):
        raise ValueError("variant must be full-document or oracle-context")
    return value


def tasks(req):
    variant = condition(req)
    root = Path(req["benchmark"]["path"])
    tasks = []
    for row in rows(req):
        exists = variant == "oracle-context" or (root / "pdfs" / (row["doc_name"] + ".pdf")).is_file()
        tasks.append({"id": row["financebench_id"], "title": row["question"], "supported": exists,
            "reason": None if exists else "Install the original source PDF for this task",
            "tags": {"suite": row["question_type"]}})
    return {"tasks": tasks, "capabilities": {
        "identity": {"id": "financebench", "name": "FinanceBench", "version": RELEASE["revision"], "variant": variant},
        "methods": ["cli", "external", "oracle", "empty"], "scoreKind": "scalar", "rescore": "score",
        "taxonomy": {"domains": ["finance"], "taskTypes": ["answering"], "modalities": ["text"],
            "interfaces": ["response"], "scoringMethods": ["human-review"]},
        "conditions": {"Data": "150 public cases only", "Context": variant,
            "Scoring": "Published human labels for exact published completions, or explicitly supplied answer-bound human reviews",
            "Oracle": "Replay of a published human-verified correct completion, if available for this condition",
            "New answers": "Require human review; absent reviews yield invalid/judge_unavailable, never an automatic score"}}}


def labels(req, task):
    root = Path(req["benchmark"]["path"])
    mode = "oracle" if condition(req) == "oracle-context" else "inContext"
    matches = []
    for name in RELEASE["files"]:
        if not name.startswith("results/"):
            continue
        for line in (root / name).read_text().splitlines():
            row = json.loads(line)
            if row["financebench_id"] == task and row["eval_mode"] == mode:
                matches.append({"answer": row["model_answer"], "score": int(row["label"] == "Correct Answer"),
                                "label": row["label"], "provenance": name})
    return matches


def problem(req):
    task = req["trial"]["task"]
    row = next(r for r in rows(req) if r["financebench_id"] == task)
    variant = condition(req)
    source = {"revision": RELEASE["revision"], "variant": variant}
    prompt = row["question"]
    if variant == "oracle-context":
        prompt += "\n\nEvidence:\n" + "\n\n".join(e["evidence_text"] for e in row["evidence"])
    else:
        pdf = Path(req["benchmark"]["path"]) / "pdfs" / (row["doc_name"] + ".pdf")
        source["documentSha256"] = hashlib.sha256(pdf.read_bytes()).hexdigest()
        prompt += "\n\nSource document: /documents/source.pdf. Use Python pypdf to read it."
    reviews = labels(req, task)
    reference = next((r["answer"] for r in reviews if r["score"] == 1), None)
    if req["trial"]["method"]["agent"] == "oracle" and reference is None:
        raise ValueError("No published human-verified reference for this task and context")
    return {"task": task, "prompts": [{"id": "0", "prompt": prompt}], "answers": [reference or ""],
            "reviews": reviews, "source": source}


def solve(req):
    result = solve_question(req, problem(req), HERE)
    if condition(req) == "full-document":
        row = next(r for r in rows(req) if r["financebench_id"] == req["trial"]["task"])
        result["spec"]["mounts"].append(mount(Path(req["benchmark"]["path"]) / "pdfs" / (row["doc_name"] + ".pdf"), "/documents/source.pdf"))
    return result


def verify(req):
    item = problem(req)
    cfg = req["benchmark"].get("config") or {}
    review_file = cfg.get("humanReviews")
    if review_file:
        for row in json.loads(Path(review_file).read_text()):
            if row["task"] == item["task"] and row["source"] == item["source"]:
                if type(row["correct"]) is not bool or not row.get("reviewer"):
                    raise ValueError("Human review requires a named reviewer and boolean correct")
                item["reviews"].append({"answerSha256": row["answerSha256"], "score": int(row["correct"]),
                                        "provenance": "human-review:" + row["reviewer"]})
    stage = verify_input(req, item)
    run = run_spec(req, stage, HERE)
    run["mounts"].append(mount(req["solve"]["output"], "/solve"))
    run["command"] = ["python", "/adapter/runtime.py", "verify"]
    return {"spec": run}


if __name__ == "__main__":
    sys.exit(main(tasks, solve, verify, question_score))
