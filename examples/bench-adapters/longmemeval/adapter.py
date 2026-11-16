#!/usr/bin/env -S python3 -B
"""LongMemEval: complete timestamped histories with private answer/evidence labels."""

import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import main
from orbit_bench.questions import checked_source, dataset, question_score, solve_question, verify_question

HERE = Path(__file__).resolve().parent
VERSION = json.loads((HERE / "release.json").read_text())["revision"]
VARIANTS = ("oracle", "s", "m")


def rows(req):
    checked_source(req, HERE)
    cfg = req["benchmark"].get("config") or {}
    variant = cfg.get("variant")
    if variant not in VARIANTS:
        raise ValueError("Set variant=oracle, s or m to identify the installed data condition")
    data, digest = dataset(req, f"data/longmemeval_{variant}.json")
    ids = [r["question_id"] for r in data]
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate question IDs")
    return data, digest, variant


def tasks(req):
    data, _, variant = rows(req)
    return {"tasks": [{"id": r["question_id"], "title": r["question"], "supported": True, "reason": None,
                       "tags": {"suite": r["question_type"], "variant": variant}} for r in data],
            "capabilities": {"identity": {"id": "longmemeval", "name": "LongMemEval", "version": VERSION, "variant": variant},
                "methods": ["cli", "external", "oracle", "empty"], "scoreKind": "scalar", "rescore": "score",
                "taxonomy": {"taskTypes": ["answering"], "modalities": ["text"], "interfaces": ["response"], "scoringMethods": ["model-judge"]},
                "calibration": {"repeat": {"tolerance": 1}},
                "conditions": {"Unit": "One question with ALL installed history sessions and timestamps",
                    "Scoring": "Native category-specific get_anscheck_prompt and native yes-substring decision",
                    "Oracle": "Reference replay; preference and abstention references are rubrics, not guaranteed full-credit responses",
                    "Variant": variant + "; oracle denotes the upstream retrieval condition, not the solve method"}}}


def problem(req):
    data, digest, variant = rows(req)
    row = next(r for r in data if r["question_id"] == req["trial"]["task"])
    sessions = [[{"role": t["role"], "content": t["content"]} for t in s] for s in row["haystack_sessions"]]
    if len(sessions) != len(row["haystack_dates"]) or len(sessions) != len(row["haystack_session_ids"]):
        raise ValueError("History IDs, timestamps and sessions must align")
    visible = {k: row[k] for k in ("question", "question_date", "haystack_dates", "haystack_session_ids")}
    visible["haystack_sessions"] = sessions
    return {"task": row["question_id"], "prompts": [{"id": "0", "prompt": json.dumps(visible, ensure_ascii=False)}],
            "answers": [str(row["answer"])], "native": row,
            "source": {"dataSha256": digest, "revision": VERSION, "variant": variant}}


def solve(req):
    return solve_question(req, problem(req), HERE)


def verify(req):
    return verify_question(req, problem(req), HERE, "gpt-4o-mini-2024-07-18")


if __name__ == "__main__":
    sys.exit(main(tasks, solve, verify, question_score))
