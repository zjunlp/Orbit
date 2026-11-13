"""Atomic evidence and verification from saved files, without rerunning a simulator."""

from __future__ import annotations

import json
import math
import os
from pathlib import Path

import numpy as np

from .binding import check_sample, digest, file_digest, reference_horizon, reset_seed, robodojo_layout


def write_json(path, value, *, compact=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".partial")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, sort_keys=True, allow_nan=False,
                  separators=(",", ":") if compact else None)
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
            target = optional_files if path.parent == directory and path.suffix == ".mp4" else files
            target[path.relative_to(directory).as_posix()] = file_digest(path)
    write_json(directory / "evidence-manifest.json", {
        "version": 1, "sampleRef": result["sampleRef"], "episodeId": result["episodeId"],
        "files": files, "optionalFiles": optional_files,
    })


def verify_calvin_sequence(reference, sample, controls, result):
    _, sequence = reference["environment"]["catalog"]["sequences"][reset_seed(sample, reference)]
    limit = reference["parameters"]["subtaskSteps"]
    completed, elapsed, replan = 0, 0, True
    for index, row in enumerate(controls):
        if row["reward"] not in (0, 1) or (replan and row["chunkIndex"] != 0):
            raise ValueError("CALVIN control evidence differs from the native sequence protocol")
        replan = row["reward"] == 1
        completed += int(replan)
        elapsed = 0 if replan else elapsed + 1
        success = completed == len(sequence)
        terminal = success or elapsed == limit
        if (row["state"]["completedSubtasks"] != completed or row["nativeSuccess"] != success
                or row["terminated"] != terminal or terminal != (index == len(controls) - 1)):
            raise ValueError("CALVIN subtask progression or stopping point is inconsistent")
    if (result["native"]["sequence"] != sequence or result["native"]["completedSubtasks"] != completed
            or result["success"] != (completed == len(sequence))):
        raise ValueError("CALVIN result differs from the recorded subtask completions")


def verify_robodojo_episode(reference, sample, controls, initial, result):
    layout = robodojo_layout(reference, sample["taskId"], sample["environmentSeed"], int(sample["initialStateId"]))
    identity = {"evalSeed": sample["environmentSeed"], **layout}
    if initial["layout"] != identity or initial["nativeStepCount"] != 0:
        raise ValueError("RoboDojo initial state differs from its frozen layout")
    for index, row in enumerate(controls):
        state = row["state"]
        progress = state["processScore"]
        if progress is not None and (isinstance(progress, bool) or not isinstance(progress, (int, float))
                                     or not math.isfinite(progress) or not 0 <= progress <= 100):
            raise ValueError("RoboDojo process score is outside its native range")
        if (state["layout"] != identity or state["nativeStepCount"] != index + 1
                or state["nativeUnstable"] is not False
                or state["nativeEnded"] is not row["terminated"]
                or state["nativeSuccess"] is not row["nativeSuccess"]
                or row["terminated"] != (index == len(controls) - 1)):
            raise ValueError("RoboDojo control evidence contradicts native termination or layout")
    final = controls[-1]["state"]
    expected_score = 1.0 if result["success"] else (final["processScore"] or 0.0) / 100.0
    native = result["native"]
    for key in ("layout", "nativeStepCount", "nativeEnded", "nativeSuccess", "nativeUnstable", "processScore"):
        if native[key] != final[key]:
            raise ValueError("RoboDojo result differs from recorded native state: " + key)
    if native["score"] != expected_score:
        raise ValueError("RoboDojo score differs from native success and process score")


def verify_simpler_termination(controls, initial, horizon):
    final = initial["finalSubtask"]
    stopped = False
    for index, row in enumerate(controls):
        action, state = row["action"], row["state"]
        requested = action[7] > 0
        stopped = (requested and final) or state["truncated"]
        if (row["nativeAction"] != action[:7] or ((requested or final) and not state["finalSubtask"])
                or row["terminated"] != stopped or (stopped and index != len(controls) - 1)):
            raise ValueError("SimplerEnv control evidence differs from the policy termination protocol")
        final = state["finalSubtask"]
    if len(controls) != horizon and not stopped:
        raise ValueError("SimplerEnv episode ended before the horizon without termination")


def verify_manipulation_stopping(kind, controls, horizon):
    for step, row in enumerate(controls, start=1):
        done, success = row.get("nativeDone"), row["nativeSuccess"]
        stopped = done is True or step == horizon or (kind == "robomimic" and success is True)
        if (type(done) is not bool or type(success) is not bool
                or row["terminated"] is not stopped or stopped != (step == len(controls))):
            raise ValueError("control evidence differs from the native termination protocol")
        if kind == "vima-bench":
            command = np.asarray(row["action"], dtype=np.float32)
            if command.shape != (12,) or row.get("nativeAction") != command.tolist():
                raise ValueError("VIMA-Bench native primitive differs from the recorded command")


def verify_robocasa_v02(controls, horizon):
    for step, row in enumerate(controls, start=1):
        action = row["action"]
        if len(action) != 7 or row.get("nativeAction") != action + [0] * 5:
            raise ValueError("RoboCasa v0.2 native action differs from the fixed-base conversion")
        success = row["nativeSuccess"]
        stopped = success is True or step == horizon
        if (type(success) is not bool or row["reward"] != int(success)
                or row["terminated"] is not stopped or stopped != (step == len(controls))):
            raise ValueError("RoboCasa v0.2 must stop at the first native success or the task horizon")


def verify_diffusion_stopping(controls, horizon, replan_steps):
    previous_success = False
    for index, row in enumerate(controls):
        chunk, offset = divmod(index, replan_steps)
        if row["chunk"] != chunk or row["chunkIndex"] != offset:
            raise ValueError("Diffusion Policy control evidence differs from the fixed chunk schedule")
        native_done = row.get("nativeDone")
        if not isinstance(native_done, bool):
            raise ValueError("Diffusion Policy control evidence lacks the native done signal")
        reward = row["reward"]
        if type(reward) not in (int, float) or reward not in (0, 1) or row["nativeSuccess"] is not (reward > 0):
            raise ValueError("Diffusion Policy success differs from the native sparse reward")
        step = index + 1
        stopped = native_done or step == horizon or (offset + 1 == replan_steps and previous_success)
        if row["terminated"] is not stopped or stopped != (step == len(controls)):
            raise ValueError("Diffusion Policy stopping point differs from the native protocol")
        previous_success = row["nativeSuccess"]


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
            version = 3 if expected["evidenceVersion"] == 4 else 2
            if contract.get("version") != version or identity.get("execution") != execution:
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
        sample = contract["sample"]
        horizon = reference_horizon(reference, sample["taskId"], sample=sample)
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
    first_replan = reference.get("parameters", {}).get("firstReplanSteps", contract["replanSteps"])
    if type(first_replan) is not int or not 0 < first_replan <= contract["replanSteps"]:
        raise ValueError("invalid initial replan interval in episode evidence")
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
        limit = first_replan if row["chunk"] == 0 else contract["replanSteps"]
        if not isinstance(index, int) or not 0 <= index < min(len(chunk), limit):
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
    if rule not in ("last", "any", "chunk-last-any"):
        raise ValueError("unsupported native success aggregation")
    if rule == "chunk-last-any":
        if result["valid"] and not controls[-1]["terminated"]:
            raise ValueError("chunked episode has no terminal control step")
        boundaries = controls[contract["replanSteps"] - 1::contract["replanSteps"]]
        if controls and len(controls) % contract["replanSteps"]:
            boundaries.append(controls[-1])
        success = any(row["nativeSuccess"] for row in boundaries)
    elif rule == "any":
        success = any(row["nativeSuccess"] for row in controls)
    else:
        success = bool(controls and controls[-1]["nativeSuccess"])
    if result["valid"] and result["success"] != success:
        raise ValueError("native verdict contradicts the declared control-step aggregation")
    if result["valid"] and reference.get("environment", {}).get("kind") == "calvin":
        verify_calvin_sequence(reference, contract["sample"], controls, result)
    if result["valid"] and reference.get("environment", {}).get("kind") == "robodojo":
        verify_robodojo_episode(reference, contract["sample"], controls, initial["state"], result)
    if result["valid"] and reference.get("environment", {}).get("kind") == "robocasa-v02":
        verify_robocasa_v02(controls, contract["horizon"])
    kind = reference.get("environment", {}).get("kind")
    if result["valid"] and kind == "bigym2":
        from .bigym2 import verify_bigym2
        verify_bigym2(reference, contract["sample"], controls, result)
    if result["valid"] and kind == "cliport":
        from .cliport import verify_cliport
        verify_cliport(reference, contract["sample"], controls, result)
    if result["valid"] and kind in ("robomimic", "vima-bench"):
        verify_manipulation_stopping(kind, controls, contract["horizon"])
    if result["valid"] and kind == "molmospaces":
        from .molmospaces import verify_molmospaces
        verify_molmospaces(controls, contract["horizon"], reference["parameters"])
    if result["valid"] and kind == "vla-arena":
        from .vla_arena import verify_arena_evidence
        verify_arena_evidence(reference, contract["sample"], controls, result,
                              [row for row in actions if row["phase"] == "settle"])
    if result["valid"] and kind == "colosseum-v2":
        native = result["native"]
        if (len(controls) != contract["horizon"] or not controls[-1]["terminated"]
                or any(row["terminated"] for row in controls[:-1])
                or native["successOnce"] is not success
                or native["successAtEnd"] is not controls[-1]["nativeSuccess"]):
            raise ValueError("Colosseum V2 horizon or success flags differ from the controls")
    if result["valid"] and kind == "libero-pro":
        task = contract["sample"]["taskId"]
        environment = reference["environment"]
        instruction = environment["taskTitles"][task]
        native = result["native"]
        if (initial["state"]["instruction"] != instruction or native["instruction"] != instruction
                or native["perturbation"] != environment["perturbation"]
                or any(row["state"]["instruction"] != instruction for row in controls)):
            raise ValueError("LIBERO-PRO policy instruction differs from the frozen BDDL")
        reset_digest = initial["state"].get("resetStateDigest")
        if not reset_digest or any(row["state"].get("resetStateDigest") != reset_digest for row in controls):
            raise ValueError("LIBERO-PRO constructor state differs across the recorded episode")
    if result["valid"] and reference.get("environment", {}).get("controller") == "lingbot-va-ee":
        from .robotwin import verify_lingbot_controls
        verify_lingbot_controls(controls, contract["horizon"], initial["state"])
    if result["valid"] and reference.get("environment", {}).get("policyTermination"):
        verify_simpler_termination(controls, initial["state"], contract["horizon"])
    if (result["valid"] and contract.get("version") == 3
            and reference.get("environment", {}).get("protocol") == "diffusion-policy"):
        verify_diffusion_stopping(controls, contract["horizon"], contract["replanSteps"])
    # A valid failure ends at the horizon or at a native termination (e.g. Gym truncation).
    if (result["valid"] and not result["success"] and result["steps"] != contract["horizon"]
            and not controls[-1]["terminated"]):
        raise ValueError("a valid failure must reach the declared horizon or a native termination")
    return result
