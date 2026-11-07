"""Generate local registrations for the RoboCasa365 benchmark and OpenPI policy."""

import argparse
import json
from pathlib import Path
import subprocess

from adapter import HERE, digest, file_digest, implementation_digest
from configure_groot import image_id
from orbit_embodied.assets import tree_digest


def check_source(root, source, files):
    commit = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    if commit != source["commit"]:
        raise ValueError("unexpected source revision for " + source["repository"])
    for name, expected in files.items():
        if file_digest(root / name) != expected:
            raise ValueError("reference source changed: " + name)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--robocasa-source", type=Path, required=True)
    parser.add_argument("--robosuite-source", type=Path, required=True)
    parser.add_argument("--openpi-source", type=Path, required=True)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--policy-image", required=True)
    parser.add_argument("--benchmark-image", required=True)
    parser.add_argument("--share-gpu", action="store_true")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    reference = json.loads((HERE / "profiles/robocasa365-atomic-seen.json").read_text())
    model = json.loads((HERE / "profiles/robocasa365-openpi.json").read_text())
    source = reference["reference"]
    check_source(args.robocasa_source, source["robocasa"], source["files"])
    for root, component in ((args.robosuite_source, "robosuite"), (args.openpi_source, "evaluation")):
        check_source(root, source[component], source[component]["files"])
    check_source(args.openpi_source, model["source"], model["source"]["files"])
    if (model["nativeProfile"] != reference["benchmarkProfile"]["id"]
            or model["replanSteps"] != reference["parameters"]["replanSteps"]):
        raise ValueError("RoboCasa365 benchmark recipe is incompatible with the OpenPI policy recipe")

    assets = reference["environment"]["assets"]
    assets["digest"] = tree_digest(args.assets)
    weights = args.weights
    required = ["_CHECKPOINT_METADATA", "params/manifest.ocdbt", "assets/norm_stats.json"]
    if any(not (weights / filename).is_file() for filename in required):
        raise ValueError("RoboCasa365 inference checkpoint is incomplete")
    checkpoint, normalization = tree_digest(weights), tree_digest(weights / "assets")
    if checkpoint != model["checkpoint"]["digest"] or normalization != model["checkpoint"]["normalizationDigest"]:
        raise ValueError("checkpoint contents differ from the published RoboCasa365 inference files")
    service = {
        "name": "policy", "image": image_id(args.policy_image), "cpus": 4, "memGB": 32, "gpuMemGB": 24,
        "env": {"JAX_PLATFORMS": "cuda", "XLA_PYTHON_CLIENT_PREALLOCATE": "false"},
        "command": ["/opt/orbit/serve_openpi.py", "--robocasa-inference", "--config", model["checkpoint"]["config"],
                    "--checkpoint", "/weights", "--checkpoint-digest", checkpoint,
                    "--normalization-digest", normalization],
        "healthcheck": {"command": ["/.venv/bin/python", "-c",
                        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5).read()"],
                        "intervalSec": 10, "timeoutSec": 6, "startPeriodSec": 300, "retries": 90},
    }
    service.update({"gpusOf": "main", "gpus": 0} if args.share_gpu else {"role": "policy", "gpus": 1})
    policy = {
        "name": "pi05-robocasa365-shared" if args.share_gpu else "pi05-robocasa365",
        "version": "1", "connector": "openpi-ws", "ioAdapter": "robocasa-native",
        "callTimeoutSec": 300, "replanSteps": model["replanSteps"], "randomness": model["randomness"],
        "profile": {**reference["benchmarkProfile"], "id": model["profileId"]},
        "checkpointDigest": checkpoint, "normalizationDigest": normalization,
        "weights": {"dataset": "pi05-robocasa365", "target": "/weights"}, "service": service,
    }
    benchmark = {
        "name": "robocasa365-atomic-seen-native", "adapter": str(HERE / "adapter.py"),
        "path": str(args.robocasa_source.resolve()),
        "config": {"image": image_id(args.benchmark_image), "python": "/usr/local/bin/python",
                   "reference": json.dumps(reference), "profileDigest": digest(reference),
                   "implementationDigest": implementation_digest(),
                   "simGpus": "1", "renderer": "egl", "simGpuMemGB": "4"},
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for filename, value in (("policy.json", policy), ("benchmark.json", benchmark), ("reference.json", reference)):
        (args.output_dir / filename).write_text(json.dumps(value, indent=2) + "\n")
    print("Wrote the pinned RoboCasa365 registrations and sample-plan reference.")


if __name__ == "__main__":
    main()
