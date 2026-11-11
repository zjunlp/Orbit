"""Freeze a sampled parity plan and generate ordinary Orbit Run specifications."""

import argparse
import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import HERE, SDK, digest, file_digest, implementation_digest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference-source", type=Path, required=True)
    parser.add_argument("--orbit-run", type=Path, required=True)
    parser.add_argument("--orbit-output", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--paired-runtime", action="store_true",
                        help="audit-only shared compiled model with independent reference/candidate RNG streams")
    parser.add_argument("--baseline-plan", type=Path, help="record the unchanged comparison criteria of a preceding plan")
    args = parser.parse_args()
    reference = json.loads((HERE / "reference.json").read_text())
    for name, relative in (("openpi", "."), ("libero", "third_party/libero")):
        source = args.reference_source / relative
        revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
        if revision != reference["reference"][name]["commit"]:
            raise ValueError("reference source revision differs: " + name)
    for relative, expected in reference["reference"]["files"].items():
        if file_digest(args.reference_source / relative) != expected:
            raise ValueError("reference source content differs: " + relative)
    episode = args.orbit_output / "episode"
    contract = json.loads((episode / "contract.json").read_text())
    result = json.loads((episode / "native-result.json").read_text())
    run = json.loads(args.orbit_run.read_text())
    if run["state"] != "succeeded" or run["cleanup"] != "done" or not result["valid"]:
        raise ValueError("comparison requires a completed, independently verified real solve")
    sample = contract["sample"]
    if sample["initialStateId"] != "0" or sample["environmentSeed"] != 7 or sample["policySeed"] != 0:
        raise ValueError("this comparison supports the official first-episode random prefix only")
    if contract["identity"]["reference"] != reference:
        raise ValueError("the original solve used another reference")
    if contract["identity"]["implementationDigest"] != implementation_digest():
        raise ValueError("the SDK/driver changed since the original solve; run a fresh candidate first")
    policy = contract["identity"]["policy"]
    if policy["kind"] != "model" or policy["randomness"] != {"backend": "jax", "initialKey": 0, "scope": "service"}:
        raise ValueError("comparison needs a real JAX model with the declared service-scoped key")
    service = next(s for s in run["spec"]["services"] if s["role"] == "policy")
    if service["image"] != policy["service"]["image"] or service["env"].get("JAX_PLATFORMS") != "cuda":
        raise ValueError("the original policy must have required CUDA with the frozen model image")
    suite = sample["taskId"].split(":", 1)[0]
    plan = {
        "version": 1, "scope": "sampled first-episode parity", "sample": sample, "suite": suite,
        "profileDigest": digest(reference), "binding": json.loads((episode / "resolved-binding.json").read_text()),
        "policy": {key: policy[key] for key in ("checkpointDigest", "normalizationDigest", "randomness", "port")},
        "policyDefinition": copy.deepcopy(policy), "reference": reference,
        "pairedRuntime": args.paired_runtime,
        "benchmarkImage": run["spec"]["image"], "policyImage": service["image"],
        "orbitEvidenceDigest": file_digest(episode / "evidence-manifest.json"),
        "orbitImplementationDigest": contract["identity"]["implementationDigest"],
        "fixedInitialStates": ["0", "1"], "fixedActionSteps": 32,
        "horizon": reference["horizons"][suite], "settleSteps": reference["parameters"]["settleSteps"],
        "comparison": {"arrays": "exact dtype, shape and values", "absoluteTolerance": 0,
                       "physics": "exact full simulator-state and raw observation fingerprints at each step",
                       "rollout": "official first episode versus saved real Orbit first episode; fresh service key 0",
                       "denominator": "one completed episode; no exceptions or omitted samples",
                       "negative": "explicit zero fixture, full native horizon; not a real VLA",
                       "excluded": ["wall time", "infer time", "video resolution", "full-suite statistical equivalence"]},
    }
    if args.paired_runtime:
        plan["comparison"]["rollout"] = "two fresh independent key-0 streams sharing immutable weights and one compiled sampler"
        plan["comparison"]["excluded"].append("bitwise repeatability between independently compiled GPU processes")
    if args.baseline_plan:
        baseline = json.loads(args.baseline_plan.read_text())
        baseline_digest = baseline.pop("digest")
        if digest(baseline) != baseline_digest:
            raise ValueError("baseline comparison plan content changed")
        for key in ("sample", "policy", "binding", "orbitEvidenceDigest", "horizon", "settleSteps", "fixedInitialStates", "fixedActionSteps"):
            if baseline[key] != plan[key]:
                raise ValueError("baseline comparison criteria changed: " + key)
        if baseline["comparison"]["absoluteTolerance"] != plan["comparison"]["absoluteTolerance"]:
            raise ValueError("baseline numeric tolerance changed")
        plan["parentPlanDigest"] = baseline_digest
    args.output_dir.mkdir(parents=True, exist_ok=False)
    staging = args.output_dir / "staging"
    staging.mkdir()
    shutil.copytree(SDK / "orbit_embodied", staging / "python/orbit_embodied",
                    ignore=shutil.ignore_patterns("test_*.py", "__pycache__"))
    shutil.copy2(args.reference_source / "examples/libero/main.py", staging / "reference_main.py")
    tools = Path(__file__).resolve().parent
    for path in (tools / "parity.py", tools / "parity_plan.py", tools / "parity_policy.py",
                 HERE / "adapter.py", HERE / "run.py"):
        shutil.copy2(path, staging / path.name)
    plan["files"] = {p.relative_to(staging).as_posix(): file_digest(p)
                     for p in sorted(staging.rglob("*")) if p.is_file()}
    plan["digest"] = digest(plan)
    (staging / "plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    for mode in ("deterministic", "rollout"):
        spec = {
            "name": "OpenPI LIBERO reference parity: " + mode,
            "image": plan["benchmarkImage"], "entrypoint": "/.venv/bin/python", "root": True,
            "command": ["/parity/parity.py", mode, "--plan", "/parity/plan.json"],
            "resources": {"gpus": 0, "cpus": 4, "memGB": 8}, "timeoutMin": 20,
            "env": {"PYTHONPATH": "/parity/python:/app/packages/openpi-client/src:/app/third_party/libero",
                    "MUJOCO_GL": "osmesa", "PYOPENGL_PLATFORM": "osmesa"},
            "mounts": [{"source": str(staging.resolve()), "target": "/parity", "mode": "ro"}],
            "tags": {"validation": "embodied-reference-parity", "phase": mode, "plan": plan["digest"]},
            "network": mode == "rollout",
        }
        if mode == "rollout":
            spec["services"] = [copy.deepcopy(service)]
            if args.paired_runtime:
                paired = spec["services"][0]
                paired["command"][0] = "/parity/parity_policy.py"
                paired["binds"].append({"source": str(staging.resolve()), "target": "/parity", "mode": "ro"})
            spec["dependsOn"] = ["policy"]
            spec["mounts"].append({"source": str(args.orbit_output.resolve()), "target": "/orbit-solve", "mode": "ro"})
        (args.output_dir / (mode + "-run.json")).write_text(json.dumps(spec, indent=2) + "\n")
    print("Frozen sampled parity plan: " + plan["digest"])


if __name__ == "__main__":
    main()
