#!/usr/bin/env -S python3 -B
"""MMAU audio test-mini with the original multiple-choice string matcher."""

import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import invalid, main, valid  # noqa: E402
from orbit_bench.batch import mount, run_spec, solve_batch, verify_input  # noqa: E402

HERE = Path(__file__).resolve().parent
REVISION = "110127f54c0dfba3faa5ec9feee4a7e4148679c5"
FILES = {"evaluation.py": "4601c85586faaf34ed224e81712d76560b6333f2",
         "mmau-test-mini.json": "a2f7539b406a7a466d554e15a22342dbfe53c461"}
TAXONOMY = {
    "taskTypes": ["answering"], "modalities": ["text", "audio"], "interfaces": ["response"],
    "platforms": ["software-system"], "world": ["controlled"], "feedback": ["none"],
    "participants": [], "scoringEvidence": ["response"], "scoringMethods": ["rule-check"],
}


def checked(req, name):
    raw = (Path(req["benchmark"]["path"]) / name).read_bytes()
    digest = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
    if digest != FILES[name]:
        raise ValueError(f"{name} differs from MMAU {REVISION}")
    return raw


def audio_path(req, row):
    root = Path(req["benchmark"]["path"]).resolve()
    path = (root / row["audio_id"]).resolve()
    if not path.is_relative_to(root):
        raise ValueError("Audio path escapes the dataset directory")
    return path


def questions(req):
    checked(req, "evaluation.py")
    return json.loads(checked(req, "mmau-test-mini.json"))


def tasks(req):
    rows = []
    for row in questions(req):
        exists = audio_path(req, row).is_file()
        rows.append({"id": row["id"], "title": row["question"], "supported": exists,
                     "reason": None if exists else "Missing official test-mini audio clip.",
                     "tags": {"suite": row["task"], "difficulty": row["difficulty"]}})
    return {"tasks": rows, "capabilities": {
        "identity": {"id": "mmau", "name": "MMAU", "version": REVISION, "variant": "audio-test-mini"},
        "taxonomy": TAXONOMY, "methods": ["external", "oracle", "empty"],
        "scoreKind": "scalar", "rescore": "score",
        "conditions": {"Input": "Original audio, question and choices; audio-capable external method required",
                       "Scoring": "Unmodified upstream evaluation.string_match; mean accuracy in [0,1]",
                       "Scope": "Public 1000-question audio test-mini; no private test or text-only substitute"},
    }}


def problem(req):
    name = req["trial"]["task"]
    row = next((r for r in questions(req) if r["id"] == name), None)
    if row is None:
        raise ValueError(f"Unknown MMAU question {name}")
    path = audio_path(req, row)
    if not path.is_file():
        raise ValueError("Missing official test-mini audio clip")
    return {"task": name, "prompts": [{"id": "0", "question": row["question"],
                                      "choices": row["choices"], "audio": "/media/audio.wav"}],
            "answers": [row["answer"]],
            "source": {"revision": REVISION, "variant": "audio-test-mini",
                       "audioSha256": hashlib.sha256(path.read_bytes()).hexdigest()}}, path


def solve(req):
    if req["trial"]["method"]["agent"] not in ("external", "oracle", "empty"):
        raise ValueError("MMAU needs an audio-capable external method")
    item, audio = problem(req)
    reply = solve_batch(req, item, HERE)
    reply["spec"]["mounts"].append(mount(audio, "/media/audio.wav"))
    reply["spec"]["collect"].append("/media/audio.wav")
    return reply


def verify(req):
    item, _ = problem(req)
    stage = verify_input(req, item)
    saved = Path(req["solve"]["output"]) / "collected/media/audio.wav"
    if hashlib.sha256(saved.read_bytes()).hexdigest() != item["source"]["audioSha256"]:
        raise ValueError("Collected audio differs from the solve input")
    (stage / "evaluation.py").write_bytes(checked(req, "evaluation.py"))
    run = run_spec(req, stage, HERE)
    run["mounts"].append(mount(req["solve"]["output"], "/solve"))
    run.update({"command": ["python", "/adapter/runtime.py", "verify"], "timeoutMin": 5})
    return {"spec": run}


def score(req):
    try:
        result = json.loads((Path(req["verify"]["output"]) / "result.json").read_text())
        if result["task"] != req["trial"]["task"]:
            raise ValueError("Result belongs to another question")
        if result.get("error"):
            return invalid("scorer_error", result["error"])
        if type(result["score"]) not in (int, float) or result["score"] not in (0, 1):
            raise ValueError("Expected a binary native score")
        return valid(result["score"], review={"files": [
            {"label": "Answer", "phase": "solve", "kind": "json", "path": "answers.json"},
            {"label": "Native evaluation", "phase": "verify", "kind": "json", "path": "result.json"}],
            "details": {"source": REVISION, "variant": "audio-test-mini"}})
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return invalid("scorer_error", f"Missing or invalid native result: {exc}")


if __name__ == "__main__":
    sys.exit(main(tasks, solve, verify, score))
