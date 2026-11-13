"""Register the released SmolVLA and MolmoAct2 LIBERO recipes."""

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import HERE, digest, implementation_digest
from native_runtime import image_id
from orbit_embodied.assets import tree_digest
from serve_lerobot import normalization_digest


MODELS = {
    "smolvla": ("libero_spatial", "libero-smolvla-native", 50, 10, 8, 16),
    "molmoact2": ("libero_goal", "libero-goal-molmoact2-native", 10, 50, 40, 64),
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=MODELS, required=True)
    parser.add_argument("--benchmark-source", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--policy-image", required=True)
    parser.add_argument("--benchmark-image", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    suite, benchmark_name, replan, settle, gpu_memory, memory = MODELS[args.model]

    reference = json.loads((HERE / "reference.json").read_text())
    reference["id"] = args.model + "-libero-reference/1"
    reference["policyProfile"] = {**reference["benchmarkProfile"], "id": args.model + "-libero-input/1"}
    reference["scoreName"] = f"{suite} success ({args.model} recipe)"
    reference["parameters"].update(settleSteps=settle, replanSteps=replan)
    reference["randomness"] = {
        "referenceEnvironment": f"Orbit native LIBERO with {settle} settle steps and frozen initial states.",
        "referencePolicy": f"Published {args.model} LIBERO checkpoint. Torch seed 0 per policy service.",
        "comparison": "Orbit uses its pinned LIBERO runtime with the registered policy recipe.",
    }

    checkpoint = tree_digest(args.weights)
    normalization = normalization_digest(args.weights, args.model)
    name = args.model + "-libero"
    policy = {"name": name, "version": "1", "connector": "policy-ws", "replanSteps": replan,
              "profile": reference["policyProfile"], "checkpointDigest": checkpoint,
              "normalizationDigest": normalization,
              "randomness": {"backend": "torch", "initialSeed": 0, "scope": "service"},
              "weights": {"dataset": name, "target": "/weights"}, "service": {
                  "name": "policy", "image": image_id(args.policy_image), "gpusOf": "main", "gpus": 0,
                  "gpuMemGB": gpu_memory, "memGB": memory, "cpus": 4,
                  "command": ["--model", args.model, "--checkpoint", "/weights",
                              "--checkpoint-digest", checkpoint, "--normalization-digest", normalization],
                  "healthcheck": {"command": ["python", "/opt/orbit/serve_lerobot.py", "--healthcheck"],
                                  "intervalSec": 5, "timeoutSec": 5, "startPeriodSec": 300, "retries": 90},
              }}
    benchmark = {"name": benchmark_name, "adapter": str(HERE / "adapter.py"),
                 "path": str(args.benchmark_source.resolve()), "config": {
                     "image": image_id(args.benchmark_image), "python": "/.venv/bin/python", "suite": suite,
                     "reference": json.dumps(reference), "profileDigest": digest(reference),
                     "implementationDigest": implementation_digest(), "simGpus": "1", "simGpuMemGB": "4",
                     "renderer": "egl",
                 }}
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name, value in (("benchmark", benchmark), ("policy", policy), ("reference", reference)):
        (args.output_dir / (name + ".json")).write_text(json.dumps(value, indent=2) + "\n")


if __name__ == "__main__":
    main()
