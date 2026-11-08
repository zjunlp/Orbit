"""Explicit, deterministic mappings between endpoint semantic descriptions."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


def digest(value):
    content = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False, ensure_ascii=False)
    return "sha256:" + hashlib.sha256(content.encode("utf-8")).hexdigest()


def file_digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return "sha256:" + result.hexdigest()


def check_sample(sample, sample_ref):
    if sample.get("sampleId") != sample_ref or digest({k: v for k, v in sample.items() if k != "sampleId"}) != sample_ref:
        raise ValueError("sampleId differs from the sample content or frozen sampleRef")


def seed_asset(reference, task):
    return digest({"reset": "environmentSeed+initialStateId", "task": task, "profile": digest(reference)})


def resolve_binding(benchmark, policy, observation_map):
    if set(observation_map) != set(policy["observations"]):
        raise ValueError("explicit mappings must cover exactly the policy observation fields")
    for target, source in observation_map.items():
        if source not in benchmark["observations"]:
            raise ValueError("missing benchmark observation: " + source)
        expected, actual = policy["observations"][target], benchmark["observations"][source]
        if not expected or expected != actual:
            raise ValueError("incompatible semantics for " + target + " <- " + source)
        if not {"semantic", "dtype", "shape"}.issubset(expected) or str(expected["semantic"]).lower() == "raw":
            raise ValueError("incomplete semantic declaration for " + target)
        if expected["semantic"] == "rgb" and (not expected.get("camera") or not expected.get("layout")):
            raise ValueError("missing camera identity or layout for " + target)
        if "position" in expected["semantic"] and not expected.get("unit"):
            raise ValueError("missing physical unit for " + target)
        if any(term in expected["semantic"] for term in ("position", "orientation")) and not expected.get("frame"):
            raise ValueError("missing coordinate frame for " + target)
    if not policy.get("action") or policy["action"] != benchmark.get("action"):
        raise ValueError("action semantics differ; an explicit verified conversion is required")
    if not {"semantic", "shape", "controller", "frame", "unit", "rotation", "gripper"}.issubset(policy["action"]):
        raise ValueError("incomplete action semantic declaration")
    result = {
        "version": 1,
        "benchmarkProfile": benchmark,
        "policyProfile": policy,
        "observationMap": dict(sorted(observation_map.items())),
    }
    return {**result, "digest": digest(result)}


def validate_observation(observation, descriptions):
    import numpy as np
    for name, description in descriptions.items():
        value = observation[name]
        if description["dtype"] == "string":
            if not isinstance(value, str):
                raise ValueError("expected text observation: " + name)
            continue
        array = np.asarray(value)
        if list(array.shape) != description["shape"] or str(array.dtype) != description["dtype"]:
            raise ValueError("observation shape or dtype mismatch: " + name)
        if not np.isfinite(array).all():
            raise ValueError("non-finite observation: " + name)


def reset_seed(sample):
    """The frozen WidowX reset recipe: environmentSeed + initialStateId."""
    return sample["environmentSeed"] + int(sample["initialStateId"])


def check_distinct_resets(samples):
    """Different sampleIds must not alias one native reset (e.g. seeds 7+1 and 8+0)."""
    seen = {}
    for sample in samples:
        key = (sample["taskId"], reset_seed(sample), sample["policySeed"], sample["repetition"])
        if seen.setdefault(key, sample["sampleId"]) != sample["sampleId"]:
            raise ValueError("two planned samples resolve to the same native reset seed")
