#!/usr/bin/env -S python3 -B
"""Direct BFCL multi-turn registration; host protocol uses only Python's stdlib."""

import hashlib
import json
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
VERSION = "2026.3.23"
WHEEL_URL = (
    "https://files.pythonhosted.org/packages/ba/41/"
    "ed458527c770c50225b60bae3b0c3444b26804ee455fa2d8f187018d2cb2/"
    "bfcl_eval-2026.3.23-py3-none-any.whl"
)
WHEEL_SHA256 = "3bb6dfa5f0c68ad403c9ec50b00db2bb3b4cc9b38ab1ff33f48fe30d853d3a0a"
CATEGORIES = tuple("multi_turn_" + s for s in ("base", "miss_func", "miss_param", "long_context"))
DOCS = {
    "GorillaFileSystem": "gorilla_file_system", "MathAPI": "math_api",
    "MessageAPI": "message_api", "TwitterAPI": "posting_api", "TicketAPI": "ticket_api",
    "TradingBot": "trading_bot", "TravelAPI": "travel_booking", "VehicleControlAPI": "vehicle_control",
}
PINS = json.loads((HERE / "data-sha256.json").read_text())
IMAGE = "orbit-bfcl-multiturn:" + VERSION


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_pinned(root, name):
    content = (root / name).read_bytes()
    if hashlib.sha256(content).hexdigest() != PINS[name]:
        raise ValueError(f"BFCL data sha256 mismatch: {name}")
    return [json.loads(line) for line in content.splitlines() if line.strip()]


def data_files(category):
    name = f"BFCL_v4_{category}.json"
    return name, "possible_answer/" + name


def load_category(root, category):
    questions, answers = (read_pinned(root, n) for n in data_files(category))
    ids = [q["id"] for q in questions]
    by_id = {a["id"]: a["ground_truth"] for a in answers}
    if len(set(ids)) != len(ids) or len(by_id) != len(answers) or set(ids) != set(by_id):
        raise ValueError(f"Question/answer IDs disagree: {category}")
    for entry in questions:
        if len(entry["question"]) != len(by_id[entry["id"]]):
            raise ValueError(f"Question/answer turns disagree: {entry['id']}")
    return questions, by_id


def settings(req):
    cfg = req["benchmark"].get("config", {})
    if set(cfg) - {"image", "categories"}:
        raise ValueError("Only image and categories are supported configuration keys")
    categories = cfg.get("categories", ",".join(CATEGORIES)).split(",")
    if not categories or len(set(categories)) != len(categories) or set(categories) - set(CATEGORIES):
        raise ValueError("categories must be a comma-separated subset of " + ",".join(CATEGORIES))
    return Path(req["benchmark"]["path"]).resolve(), cfg.get("image", IMAGE), categories


def held_tools(entry, turn):
    return {name for release, names in entry.get("missed_function", {}).items()
            if int(release) > turn for name in names}


def support_reason(entry, ground_truth):
    unknown = set(entry["involved_classes"]) - set(DOCS)
    if unknown:
        return "Unsupported tool classes: " + ", ".join(sorted(unknown))
    for turn, calls in enumerate(ground_truth):
        for call in calls:
            name = call.split("(", 1)[0].strip()
            if name in held_tools(entry, turn):
                return f"Upstream reference calls held-out tool {name} before release (turn {turn})"
    return None


def tasks(req):
    root, image, categories = settings(req)
    rows = []
    for category in categories:
        entries, answers = load_category(root, category)
        for entry in entries:
            reason = support_reason(entry, answers[entry["id"]])
            rows.append({
                "id": entry["id"], "title": entry["question"][0][0]["content"],
                "supported": reason is None, "reason": reason,
                "tags": {"suite": category, "oracle": "full", "turns": str(len(entry["question"]))},
            })
    for doc in DOCS.values():
        read_pinned(root, f"multi_turn_func_doc/{doc}.json")
    return {
        "tasks": rows,
        "capabilities": {
            "category": "tool-workflow", "profiles": ["local-state"],
            "methods": ["oracle", "empty"], "scoreKind": "binary", "rescore": "evidence",
            "calibration": {"empty": "min", "oracle": "max", "repeat": "exact", "seedsVary": False},
            "conditions": {
                "Identity": "Berkeley Function Calling Leaderboard (BFCL), multi-turn execution",
                "Upstream": "https://github.com/ShishirPatil/gorilla/tree/main/berkeley-function-call-leaderboard",
                "Code": f"bfcl-eval=={VERSION}; wheel sha256:{WHEEL_SHA256}",
                "Image": image,
                "Categories": ", ".join(categories),
                "Trial": "One complete conversation; fixture random seeds remain upstream; trial seeds repeat it",
                "IO": "Upstream user turns and tool schemas; literal Python function calls; final text is ungraded",
                "Environment": "Dedicated local Python environments per Run; fresh reset; solve and verify offline",
                "Resources": "Each phase: 1 CPU, 1 GiB, 0 GPU, 5 minutes; no API quota or devices",
                "Scoring": "Unmodified multi_turn_checker: per-turn state and tool response checks; binary accuracy",
                "Irrelevance": "Diagnostic only, matching this version's eval_runner which does not gate on it",
                "Trust": "Verify replays only calls in fresh environments; saved solve scores/results/states are not trusted",
                "Trajectory": "evidence.json (solve); replay.json and verdict.json (verify); indexed as JSON review files",
                **{"sha256 " + k: v for k, v in PINS.items()
                   if k.startswith("multi_turn_func_doc/") or any(k in data_files(c) for c in categories)},
            },
        },
        "official": {"name": "BFCL multi-turn conversation accuracy", "version": VERSION,
                     "errors": "exclude", "unit": "sample"},
    }


def plan(req, phase):
    root, image, categories = settings(req)
    trial = req["trial"]
    category, _, index = trial["task"].rpartition("_")
    if category not in categories or not re.fullmatch(r"[0-9]+", index):
        raise ValueError("Unknown BFCL task")
    entries, answers = load_category(root, category)
    entry = next((e for e in entries if e["id"] == trial["task"]), None)
    if entry is None:
        raise ValueError("Unknown BFCL task")
    reason = support_reason(entry, answers[trial["task"]])
    if reason:
        raise ValueError(reason)
    if trial["method"]["agent"] not in ("oracle", "empty"):
        raise ValueError("This sample implements only oracle and empty; no model API methods")
    staging = Path(trial["staging"])
    staging.mkdir(parents=True, exist_ok=True)
    # Re-created for rescore; only the oracle solve receives ground truth.
    payload = {"entry": entry, "seed": trial["seed"], "version": VERSION,
               "digests": {n: PINS[n] for n in data_files(category)},
               "tools": {c: read_pinned(root, f"multi_turn_func_doc/{DOCS[c]}.json")
                         for c in entry["involved_classes"]}}
    if phase == "verify" or trial["method"]["agent"] == "oracle":
        payload["ground_truth"] = answers[trial["task"]]
    if phase == "verify":
        payload["solve_failed"] = req["solve"].get("run", {}).get("state", "succeeded") != "succeeded"
    payload_path = staging / (phase + ".json")
    payload_path.write_text(json.dumps(payload, ensure_ascii=False))
    mounts = [
        {"source": str(HERE), "target": "/orbit-adapter", "mode": "ro"},
        {"source": str(payload_path), "target": "/input.json", "mode": "ro"},
    ]
    if phase == "verify":
        mounts.append({"source": req["solve"]["output"], "target": "/solve", "mode": "ro"})
    return {"spec": {
        "image": image, "entrypoint": "python3",
        "command": ["-B", "/orbit-adapter/runtime.py", phase, trial["method"]["agent"]],
        "mounts": mounts, "network": False,
        "env": {"PYTHONDONTWRITEBYTECODE": "1", "PYTHONHASHSEED": "0", "TZ": "UTC"},
        "resources": {"cpus": 1, "memGB": 1, "gpus": 0},
        "timeoutMin": (trial.get("timeoutMin") or 5) if phase == "solve" else 5,
    }}


def solve(req):
    return plan(req, "solve")


def verify(req):
    return plan(req, "verify")


def score(req):
    from orbit_bench import invalid, valid

    review = {"files": [
        {"label": "Conversation", "phase": "verify", "path": "conversation.json", "kind": "conversation",
         "fallback": "json"},
        {"label": "Calls, results and per-turn states", "phase": "solve", "path": "evidence.json", "kind": "json"},
        {"label": "Independent replay", "phase": "verify", "path": "replay.json", "kind": "json"},
        {"label": "Upstream checker verdict", "phase": "verify", "path": "verdict.json", "kind": "json"},
    ], "details": {"scorer": "BFCL " + VERSION, "trust": "Independent offline replay"}}
    try:
        body = json.loads((Path(req["verify"]["output"]) / "verdict.json").read_text())
        if body["task"] != req["trial"]["task"] or body["seed"] != req["trial"]["seed"] or body["version"] != VERSION:
            raise ValueError("Verifier identity mismatch")
        if body.get("failure"):
            return invalid(body["failure"], body["issue"], review=review)
        if type(body["checker"]["valid"]) is not bool:
            raise ValueError("Malformed upstream verdict")
        passed = body["checker"]["valid"]
        return valid(int(passed), review=review,
                     episode={"steps": body["calls"], "terminated": True,
                              "endedBy": "success" if passed else "horizon"})
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return invalid("scorer_error", f"BFCL verifier output: {exc}", review=review)


if __name__ == "__main__":
    sys.path.insert(0, str(HERE.parents[1] / "sdk"))
    from orbit_bench import main

    sys.exit(main(tasks, solve, verify, score))
