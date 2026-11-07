"""Atomic evidence and verification from saved files, without rerunning a simulator."""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np

from .binding import check_sample, digest, file_digest, reference_horizon


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
        if identity.get("batch") != expected.get("batch"):
            raise ValueError("episode batch prefix or attempt differs from the frozen plan")
        if expected.get("batch"):
            batch = expected["batch"]
            member = batch["plan"]["members"][batch["index"]]
            if (member["episodeId"] != episode_id or member["sampleRef"] != sample_ref
                    or digest({key: value for key, value in batch["plan"].items() if key != "digest"}) != batch["plan"]["digest"]):
                raise ValueError("batch sample or episode attempt mismatch")
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
    reference = contract["identity"].get("reference", {})
    if "parameters" in reference:
        task = contract["sample"]["taskId"]
        horizon = reference_horizon(reference, task)
        if horizon is not None and contract["horizon"] != horizon:
            raise ValueError("episode horizon differs from the frozen reference")
        if contract["replanSteps"] != reference["parameters"]["replanSteps"]:
            raise ValueError("execution horizon differs from the frozen reference")
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
        if "conversion" in timing:
            from .openpi import CONVERSIONS
            raw_path = "chunks/" + str(row["chunk"]) + ".raw.npy"
            if timing["conversion"] not in CONVERSIONS or raw_path not in manifest["files"]:
                raise ValueError("converted action chunk lacks its raw model output")
            raw = np.load(directory / raw_path, allow_pickle=False)
            if not np.array_equal(CONVERSIONS[timing["conversion"]](raw), chunk):
                raise ValueError("native actions differ from the recorded conversion of the model output")
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
    budget = contract.get("episodeBudgetSec")
    if result["valid"] and budget is not None and any(row["wallSeconds"] >= budget for row in controls):
        raise ValueError("valid verdict exceeds the episode deadline")
    if result["valid"]:
        if "initial-state.json" not in manifest["files"]:
            raise ValueError("initial-state evidence is missing")
        initial = json.loads((directory / "initial-state.json").read_text())
        if initial["sampleRef"] != sample_ref or initial["initialStateId"] != contract["sample"].get("initialStateId") or initial["initialStateDigest"] != contract["sample"].get("initialStateDigest"):
            raise ValueError("initial-state evidence differs from the sample plan")
    rule = contract["identity"].get("reference", {}).get("parameters", {}).get("successRule", "last")
    if rule not in ("last", "any"):
        raise ValueError("unsupported native success aggregation")
    success = any(row["nativeSuccess"] for row in controls) if rule == "any" else bool(controls and controls[-1]["nativeSuccess"])
    if result["valid"] and result["success"] != success:
        raise ValueError("native verdict contradicts the declared control-step aggregation")
    # A valid failure ends at the horizon or at a native termination (e.g. Gym truncation).
    if (result["valid"] and not result["success"] and result["steps"] != contract["horizon"]
            and not controls[-1]["terminated"]):
        raise ValueError("a valid failure must reach the declared horizon or a native termination")
    return result
