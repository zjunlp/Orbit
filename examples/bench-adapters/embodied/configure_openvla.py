"""Register an independent OFT policy and a recipe for the existing native LIBERO adapter."""

import argparse
import json
from pathlib import Path

from adapter import HERE, digest, file_digest, implementation_digest
from configure_groot import image_id
from orbit_embodied.assets import tree_digest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference-source", type=Path, required=True)
    parser.add_argument("--benchmark-source", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--policy-image", required=True)
    parser.add_argument("--benchmark-image", required=True)
    parser.add_argument("--share-gpu", action="store_true")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    model_reference = json.loads((HERE / "profiles/openvla-model.json").read_text())
    for name, expected in model_reference["files"].items():
        if file_digest(args.reference_source / name) != expected:
            raise ValueError("model reference source changed: " + name)
    reference = json.loads((HERE / "profiles/openvla-libero.json").read_text())
    root = args.benchmark_source.resolve()
    for name, expected in reference["reference"]["files"].items():
        if file_digest(root / name) != expected:
            raise ValueError("benchmark reference source changed: " + name)
    weights = args.weights.resolve()
    index = json.loads((weights / "model.safetensors.index.json").read_text())
    required = set(index["weight_map"].values()) | {
        "action_head--150000_checkpoint.pt", "proprio_projector--150000_checkpoint.pt",
        "config.json", "dataset_statistics.json", "preprocessor_config.json", "processor_config.json",
        "tokenizer_config.json", "tokenizer.json", "tokenizer.model", "special_tokens_map.json",
    }
    if any(not (weights / name).is_file() for name in required) or list(weights.rglob("*.partial")):
        raise ValueError("OFT inference checkpoint is incomplete")
    checkpoint, normalization = tree_digest(weights), file_digest(weights / "dataset_statistics.json")
    service = {
        "name": "policy", "image": image_id(args.policy_image), "cpus": 4, "memGB": 32, "gpuMemGB": 24,
        "command": ["/opt/orbit/serve_openvla.py", "--checkpoint", "/weights",
                    "--checkpoint-digest", checkpoint, "--normalization-digest", normalization,
                    "--unnorm-key", model_reference["unnormKey"]],
        "healthcheck": {"command": ["python", "/opt/orbit/serve_openvla.py", "--healthcheck"],
                        "intervalSec": 5, "timeoutSec": 5, "startPeriodSec": 300, "retries": 90},
    }
    service.update({"gpusOf": "main", "gpus": 0} if args.share_gpu else {"role": "policy", "gpus": 1})
    policy = {"name": "openvla-oft-libero-spatial", "version": "1", "kind": "model",
              "connector": "openvla-ws", "ioAdapter": "libero-native", "replanSteps": 8, "port": 8000,
              "callTimeoutSec": 300, "randomness": {"backend": "torch", "initialSeed": 0, "scope": "service"},
              "profile": reference["policyProfile"], "checkpointDigest": checkpoint,
              "normalizationDigest": normalization, "service": service,
              "weights": {"dataset": "openvla-oft-libero-spatial", "target": "/weights"}}
    benchmark = {"name": "libero-oft-native", "adapter": str(HERE / "adapter.py"), "path": str(root),
                 "config": {"image": image_id(args.benchmark_image), "python": "/.venv/bin/python",
                            "suite": "libero_spatial", "reference": json.dumps(reference),
                            "profileDigest": digest(reference), "implementationDigest": implementation_digest(),
                            "simGpus": "1" if args.share_gpu else "0",
                            "renderer": "egl" if args.share_gpu else "osmesa",
                            **({"simGpuMemGB": "4"} if args.share_gpu else {})}}
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for filename, value in (("policy.json", policy), ("benchmark.json", benchmark), ("reference.json", reference)):
        (args.output_dir / filename).write_text(json.dumps(value, indent=2) + "\n")
    print("Wrote pinned OFT policy and native LIBERO recipe; register them through the Orbit API.")


if __name__ == "__main__":
    main()
