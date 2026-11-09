"""One synchronous episode inside an Orbit Run; resource scheduling stays outside."""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import time
from typing import Optional

import numpy as np

from .binding import check_sample, digest, validate_observation
from .evidence import seal, write_json


class EpisodeFailure(RuntimeError):
    def __init__(self, kind, message, *, rejected_actions=None):
        super().__init__(message)
        self.kind = kind
        self.rejected_actions = rejected_actions


class SampleRejected(RuntimeError):
    """The benchmark rejected a frozen sample during native feasibility checks."""

    failure = "sample_rejected"


class EpisodeCancelled(BaseException):
    """Stop a batch without sealing an incomplete episode as a scored result."""


@dataclass
class StepResult:
    observation: dict
    reward: float
    terminated: bool
    success: bool
    simulation_time: Optional[float] = None
    native_action: Optional[list] = None
    replan: bool = False
    native_done: Optional[bool] = None


def run_episode(benchmark, policy, sample, binding, directory, episode_id, identity,
                *, prepare=None, cancelled=None, deadline=None, seal_before_media=False):
    check_sample(sample, sample["sampleId"])
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    write_json(directory / "resolved-binding.json", binding)
    sample_ref = sample["sampleId"]
    start = time.monotonic()
    # Seconds from start; the verifier rejects valid results whose control steps end past it.
    budget = None if deadline is None else deadline - start
    reference = identity.get("reference", {})
    version = 2 if "execution" in identity else 1
    if reference.get("environment", {}).get("protocol") == "diffusion-policy":
        version = 3
    contract = {
        "version": version, "sampleRef": sample_ref, "episodeId": episode_id,
        "sample": sample, "sampleDigest": digest(sample), "bindingDigest": binding["digest"],
        "horizon": benchmark.horizon, "replanSteps": policy.replan_steps, "identity": identity,
        **({"episodeBudgetSec": budget} if budget is not None else {}),
    }
    write_json(directory / "contract.json", contract)
    result = {"version": 1, "sampleRef": sample_ref, "episodeId": episode_id,
              "success": False, "valid": False, "steps": 0, "issues": []}
    stage = "reset_failed"
    recording = False
    completed = False
    sealed = False

    def check_control():
        if cancelled is not None and cancelled():
            raise EpisodeCancelled()
        if deadline is not None and time.monotonic() >= deadline:
            raise EpisodeFailure("call_watchdog", "episode watchdog expired")

    def final_issue(message):
        if sealed:
            write_json(directory / "media-status.json", {"issues": [message]})
        else:
            result["issues"].append(message)
    if hasattr(benchmark, "start_video"):
        try:
            benchmark.start_video(directory)
            recording = True
        except Exception as exc:
            result["issues"].append("optional video: " + str(exc))
    try:
        with (directory / "actions.jsonl").open("w", encoding="utf-8") as log:
            check_control()
            if prepare is not None:
                prepare()
                check_control()
            observation = benchmark.reset(sample)
            write_json(directory / "initial-state.json", {"sampleRef": sample_ref,
                       "state": benchmark.state(observation),
                       "initialStateId": sample.get("initialStateId"),
                       "initialStateDigest": sample.get("initialStateDigest")})
            for row in getattr(benchmark, "reset_actions", []):
                log.write(json.dumps(row, allow_nan=False) + "\n")
            stage = "policy_start"
            policy.reset(sample)
            chunk, chunk_index, call = [], 0, -1
            for step in range(benchmark.horizon):
                check_control()
                if recording:
                    try:
                        benchmark.record_frame(observation)
                    except Exception as exc:
                        result["issues"].append("optional video: " + str(exc))
                        recording = False
                if chunk_index >= len(chunk):
                    stage = "env_step"
                    inputs = {target: observation[source] for target, source in binding["observationMap"].items()}
                    validate_observation(inputs, binding["policyProfile"]["observations"])
                    stage = "policy_act"
                    call += 1
                    chunks = directory / "chunks"
                    chunks.mkdir(exist_ok=True)
                    called = time.monotonic()
                    try:
                        requested = np.asarray(policy.act(inputs))
                    except EpisodeFailure as exc:
                        if exc.rejected_actions is not None:
                            raw = np.asarray(exc.rejected_actions)
                            rejection = {"sourceObservation": step, "encoding": "raw-policy-actions",
                                         "reason": str(exc), "dtype": str(raw.dtype), "shape": list(raw.shape)}
                            if raw.dtype.kind in "buif":
                                np.save(chunks / (str(call) + ".rejected.npy"), raw, allow_pickle=False)
                            else:
                                rejection["preview"] = repr(raw)[:500]
                            write_json(chunks / (str(call) + ".rejected.json"), rejection)
                        raise
                    elapsed = time.monotonic() - called
                    if requested.dtype.kind not in "buif":
                        write_json(chunks / (str(call) + ".rejected.json"), {"dtype": str(requested.dtype), "shape": list(requested.shape), "preview": repr(requested)[:500]})
                        raise ValueError("policy returned non-numeric actions")
                    timing = {"sourceObservation": step, "inferSeconds": elapsed}
                    conversion = getattr(policy, "conversion", None)
                    if conversion is not None:
                        from .openpi import CONVERSIONS
                        # Keep the model's own output so a rescore can audit the native conversion.
                        np.save(chunks / (str(call) + ".raw.npy"), requested, allow_pickle=False)
                        requested = CONVERSIONS[conversion](requested)
                        timing["conversion"] = conversion
                    np.save(chunks / (str(call) + ".npy"), requested, allow_pickle=False)
                    write_json(chunks / (str(call) + ".json"), timing)
                    if requested.ndim != 2 or requested.shape[1] != benchmark.action_size or len(requested) < policy.replan_steps or not np.isfinite(requested).all():
                        raise ValueError("policy action chunk has invalid shape, length or non-finite values")
                    chunk, chunk_index = requested[:policy.replan_steps], 0
                action = chunk[chunk_index]
                check_control()
                stage = "env_step"
                native = benchmark.step(action)
                row = {"phase": "control", "step": step, "sourceObservation": step - chunk_index,
                       "chunk": call, "chunkIndex": chunk_index, "action": action.tolist(),
                       "reward": float(native.reward), "terminated": bool(native.terminated),
                       "nativeSuccess": bool(native.success), "wallSeconds": time.monotonic() - start,
                       "simulationSeconds": native.simulation_time,
                       "state": benchmark.state(native.observation)}
                if native.native_action is not None:
                    row["nativeAction"] = native.native_action
                if native.native_done is not None:
                    row["nativeDone"] = native.native_done
                log.write(json.dumps(row, allow_nan=False) + "\n")
                log.flush()
                result["steps"] = step + 1
                if budget is not None and row["wallSeconds"] >= budget:
                    raise EpisodeFailure("call_watchdog", "episode watchdog expired during an environment step")
                chunk_index = len(chunk) if native.replan else chunk_index + 1
                observation = native.observation
                if native.terminated:
                    break
            verdict = benchmark.result()
            result.update(success=bool(verdict["success"]), valid=True, native=verdict)
            completed = True
    except Exception as exc:
        if stage == "reset_failed" and isinstance(exc, SampleRejected):
            result["failure"] = SampleRejected.failure
        else:
            result["failure"] = getattr(exc, "kind", stage)
        result["issues"].append(str(exc))
        (directory / "actions.jsonl").touch(exist_ok=True)
        completed = True
    finally:
        if seal_before_media and completed:
            result["wallSeconds"] = time.monotonic() - start
            seal(directory, result)
            sealed = True
        if hasattr(benchmark, "finish_video") and (completed or not seal_before_media):
            try:
                benchmark.finish_video()
            except Exception as exc:
                final_issue("optional video finalization: " + str(exc))
        for endpoint in (policy, benchmark):
            try:
                endpoint.close()
            except Exception as exc:
                final_issue("endpoint close: " + str(exc))
    if not sealed:
        result["wallSeconds"] = time.monotonic() - start
        seal(directory, result)
    return result
