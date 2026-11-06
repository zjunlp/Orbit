"""Atomic evidence and verification from saved files, without rerunning a simulator."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import numpy as np

from .binding import check_sample, digest


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".partial")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, sort_keys=True, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def file_digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return "sha256:" + result.hexdigest()


def seal(directory, result):
    directory = Path(directory)
    write_json(directory / "native-result.json", result)
    files, optional_files = {}, {}
    for path in sorted(directory.rglob("*")):
        if path.is_file() and path.name != "evidence-manifest.json" and not path.name.endswith(".partial"):
            target = optional_files if path.name == "video.mp4" else files
            target[path.relative_to(directory).as_posix()] = file_digest(path)
    write_json(directory / "evidence-manifest.json", {
        "version": 1, "sampleRef": result["sampleRef"], "episodeId": result["episodeId"],
        "files": files, "optionalFiles": optional_files,
    })


def verify_episode(directory, sample_ref, episode_id, expected=None):
    directory = Path(directory).resolve()
    manifest = json.loads((directory / "evidence-manifest.json").read_text())
    if manifest.get("version") != 1 or manifest.get("sampleRef") != sample_ref or manifest.get("episodeId") != episode_id:
        raise ValueError("evidence belongs to another sample or attempt")
    required = {"contract.json", "resolved-binding.json", "actions.jsonl", "native-result.json"}
    if not required.issubset(manifest["files"]):
        raise ValueError("required evidence is missing")
    for name, expected_hash in manifest["files"].items():
        path = directory / name
        if Path(name).is_absolute() or ".." in Path(name).parts or path.is_symlink() or directory not in path.resolve().parents:
            raise ValueError("evidence path escapes its directory")
        if file_digest(path) != expected_hash:
            raise ValueError("evidence digest mismatch: " + name)
    contract = json.loads((directory / "contract.json").read_text())
    binding = json.loads((directory / "resolved-binding.json").read_text())
    result = json.loads((directory / "native-result.json").read_text())
    check_sample(contract["sample"], sample_ref)
    if expected is not None:
        identity = contract["identity"]
        for name, actual in (("sample", contract["sample"]), ("binding", binding),
                             ("reference", identity.get("reference")), ("policy", identity.get("policy"))):
            if actual != expected[name]:
                raise ValueError("evidence differs from the frozen " + name)
        if identity.get("implementationDigest") != expected["solveImplementationDigest"]:
            raise ValueError("solve implementation differs from the frozen registration")
        if not episode_id.startswith(expected["executionTrialId"] + "."):
            raise ValueError("episode attempt belongs to another execution trial")
        execution = {"runId": expected["solveRunId"], "trialId": expected["executionTrialId"]}
        if expected["evidenceVersion"] >= 2 or "execution" in identity:
            if contract.get("version") != 2 or identity.get("execution") != execution:
                raise ValueError("evidence belongs to another solve Run or execution trial")
    if digest({k: v for k, v in binding.items() if k != "digest"}) != binding["digest"]:
        raise ValueError("resolved binding digest mismatch")
    for record in (contract, result):
        if record.get("sampleRef") != sample_ref or record.get("episodeId") != episode_id:
            raise ValueError("contract/result identity mismatch")
    if contract["bindingDigest"] != binding["digest"] or digest(contract["sample"]) != contract["sampleDigest"]:
        raise ValueError("contract fingerprint mismatch")
    actions = [json.loads(line) for line in (directory / "actions.jsonl").read_text().splitlines()]
    controls = [row for row in actions if row["phase"] == "control"]
    if result["valid"]:
        settling = contract["identity"].get("reference", {}).get("parameters", {}).get("settleSteps")
        if settling is not None:
            reset_actions = [row for row in actions if row["phase"] == "settle"]
            if len(reset_actions) != settling or [row["step"] for row in reset_actions] != list(range(settling)):
                raise ValueError("settle actions differ from the reference protocol")
    if len(controls) != result["steps"] or [row["step"] for row in controls] != list(range(result["steps"])):
        raise ValueError("executed action sequence is incomplete")
    for row in controls:
        chunk_path = "chunks/" + str(row["chunk"]) + ".npy"
        timing_path = "chunks/" + str(row["chunk"]) + ".json"
        if chunk_path not in manifest["files"] or timing_path not in manifest["files"]:
            raise ValueError("requested action chunk is missing")
        chunk = np.load(directory / chunk_path, allow_pickle=False)
        timing = json.loads((directory / timing_path).read_text())
        index = row["chunkIndex"]
        if not isinstance(index, int) or not 0 <= index < min(len(chunk), contract["replanSteps"]):
            raise ValueError("executed action has an invalid chunk index")
        if not np.array_equal(np.asarray(row["action"]), chunk[index]) or not np.isfinite(chunk).all():
            raise ValueError("executed action differs from the requested action")
        if row["sourceObservation"] != timing["sourceObservation"] or row["sourceObservation"] + index != row["step"]:
            raise ValueError("action is linked to the wrong observation")
    if not isinstance(result["success"], bool) or not isinstance(result["valid"], bool):
        raise ValueError("invalid native verdict")
    if result["valid"] and (result.get("failure") or not controls or result["steps"] > contract["horizon"]):
        raise ValueError("valid verdict contradicts execution evidence")
    if result["valid"]:
        if "initial-state.json" not in manifest["files"]:
            raise ValueError("initial-state evidence is missing")
        initial = json.loads((directory / "initial-state.json").read_text())
        if initial["sampleRef"] != sample_ref or initial["initialStateId"] != contract["sample"].get("initialStateId") or initial["initialStateDigest"] != contract["sample"].get("initialStateDigest"):
            raise ValueError("initial-state evidence differs from the sample plan")
    if result["valid"] and result["success"] != bool(controls[-1]["nativeSuccess"]):
        raise ValueError("native verdict contradicts the last control step")
    if result["valid"] and not result["success"] and result["steps"] != contract["horizon"]:
        raise ValueError("a valid failure must reach the declared horizon")
    return result
