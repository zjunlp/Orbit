"""Register an independent OFT policy and a recipe for the existing native LIBERO adapter."""

import argparse
import json
from pathlib import Path

from adapter import HERE, digest, file_digest, implementation_digest
from configure_groot import image_id
from orbit_embodied.assets import tree_digest
from orbit_embodied.libero_suites import SUITES, LABELS, benchmark_name


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference-source", type=Path, required=True)
    parser.add_argument("--benchmark-source", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--model", choices=("spatial", "combined"), default="spatial")
    parser.add_argument("--suite", choices=SUITES, default="libero_spatial")
    parser.add_argument("--policy-image", required=True)
    parser.add_argument("--benchmark-image", required=True)
    parser.add_argument("--share-gpu", action="store_true")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    model_reference = json.loads((HERE / "profiles/openvla-model.json").read_text())
    selected = model_reference["models"][args.model]
    if args.suite not in selected["unnormKeys"]:
        parser.error("the selected checkpoint has no normalization for this LIBERO suite")
    for name, expected in model_reference["files"].items():
        if file_digest(args.reference_source / name) != expected:
            raise ValueError("model reference source changed: " + name)
    reference = json.loads((HERE / "profiles/openvla-libero.json").read_text())
    reference["scoreName"] = f"LIBERO {LABELS[args.suite].title()} success (OFT recipe)"
    root = args.benchmark_source.resolve()
    for name, expected in reference["reference"]["files"].items():
        if file_digest(root / name) != expected:
            raise ValueError("benchmark reference source changed: " + name)
    weights = args.weights.resolve()
    index = json.loads((weights / "model.safetensors.index.json").read_text())
    required = set(index["weight_map"].values()) | {
        "action_head--" + str(selected["checkpointStep"]) + "_checkpoint.pt",
        "proprio_projector--" + str(selected["checkpointStep"]) + "_checkpoint.pt",
        "config.json", "dataset_statistics.json", "preprocessor_config.json", "processor_config.json",
        "tokenizer_config.json", "tokenizer.json", "tokenizer.model", "special_tokens_map.json",
    }
    if any(not (weights / name).is_file() for name in required) or list(weights.rglob("*.partial")):
        raise ValueError("OFT inference checkpoint is incomplete")
    if selected["unnormKeys"][args.suite] not in json.loads((weights / "dataset_statistics.json").read_text()):
        raise ValueError("checkpoint statistics do not contain the selected suite normalization")
    checkpoint, normalization = tree_digest(weights), file_digest(weights / "dataset_statistics.json")
    service = {
        "name": "policy", "image": image_id(args.policy_image), "cpus": 4, "memGB": 32, "gpuMemGB": 24,
        "command": ["/opt/orbit/serve_openvla.py", "--checkpoint", "/weights",
                    "--checkpoint-digest", checkpoint, "--normalization-digest", normalization,
                    "--unnorm-key", selected["unnormKeys"][args.suite]],
        "healthcheck": {"command": ["python", "/opt/orbit/serve_openvla.py", "--healthcheck"],
                        "intervalSec": 5, "timeoutSec": 5, "startPeriodSec": 300, "retries": 90},
    }
    service.update({"gpusOf": "main", "gpus": 0} if args.share_gpu else {"role": "policy", "gpus": 1})
    name = "openvla-oft-libero-spatial" if args.model == "spatial" else "openvla-oft-libero-combined-" + LABELS[args.suite]
    dataset = "openvla-oft-libero-" + args.model
    policy = {"name": name, "version": "1", "kind": "model",
              "connector": "openvla-ws", "ioAdapter": "libero-native", "replanSteps": 8, "port": 8000,
              "callTimeoutSec": 300, "randomness": {"backend": "torch", "initialSeed": 0, "scope": "service"},
              "profile": reference["policyProfile"], "checkpointDigest": checkpoint,
              "normalizationDigest": normalization, "service": service,
              "normalizationKey": selected["unnormKeys"][args.suite],
              "weights": {"dataset": dataset, "target": "/weights"}}
    benchmark = {"name": benchmark_name(args.suite, oft=True), "adapter": str(HERE / "adapter.py"), "path": str(root),
                 "config": {"image": image_id(args.benchmark_image), "python": "/.venv/bin/python",
                            "suite": args.suite, "reference": json.dumps(reference),
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
