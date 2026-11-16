#!/usr/bin/env -S python3 -B
"""HealthBench original conversations, private rubrics and native per-example scoring."""

import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import main
from orbit_bench.questions import checked_source, dataset, question_score, solve_question, verify_question

HERE = Path(__file__).resolve().parent
VERSION = json.loads((HERE / "release.json").read_text())["revision"]


def rows(req):
    checked_source(req, HERE)
    data, digest = dataset(req, "healthbench.jsonl")
    ids = [r["prompt_id"] for r in data]
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate prompt IDs")
    return data, digest


def tasks(req):
    data, _ = rows(req)
    return {"tasks": [{"id": r["prompt_id"], "title": r["prompt_id"], "supported": True, "reason": None,
                       "tags": {"suite": "healthbench"}} for r in data],
            "capabilities": {"identity": {"id": "healthbench", "name": "HealthBench", "version": VERSION},
                "methods": ["cli", "external", "empty"], "scoreKind": "scalar", "rescore": "score",
                "taxonomy": {"domains": ["healthcare"], "taskTypes": ["answering"],
                    "modalities": ["text"], "interfaces": ["response"], "scoringMethods": ["model-judge"]},
                "calibration": {"oracle": "none", "repeat": {"tolerance": 1}},
                "conditions": {"Unit": "One original conversation; rubrics private",
                    "Judge": "Separate verifier API key and explicitly recorded judge model",
                    "Scoring": "Native raw per-example score; may be negative. Official aggregate clips AFTER averaging; Orbit displays the raw mean.",
                    "Oracle": "No guaranteed full-credit reference; physician completions are not an oracle"}}}


def problem(req):
    data, digest = rows(req)
    row = next(r for r in data if r["prompt_id"] == req["trial"]["task"])
    return {"task": row["prompt_id"], "prompts": [{"id": "0", "prompt": json.dumps(row["prompt"], ensure_ascii=False)}],
            "answers": [], "native": row,
            "source": {"dataSha256": digest, "revision": VERSION}}


def solve(req):
    return solve_question(req, problem(req), HERE)


def verify(req):
    return verify_question(req, problem(req), HERE, "gpt-4.1-2025-04-14")


if __name__ == "__main__":
    sys.exit(main(tasks, solve, verify, question_score))
