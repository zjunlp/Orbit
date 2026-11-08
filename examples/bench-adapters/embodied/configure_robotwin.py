"""Generate independent local registrations for RoboTwin and the published OpenPI recipe."""

import argparse
import json
from pathlib import Path

from adapter import HERE, check_source, digest, implementation_digest
from configure_groot import image_id
from orbit_embodied.assets import tree_digest


def configure_benchmark(args, reference):
    check_source(args.robotwin_source, reference["reference"]["evaluation"], reference["reference"]["files"])
    reference["environment"]["assets"]["digest"] = tree_digest(args.assets)
    return {
        "name": "robotwin-demo-clean-native", "adapter": str(HERE / "adapter.py"),
        "path": str(args.robotwin_source.resolve()),
        "config": {"image": image_id(args.benchmark_image), "reference": json.dumps(reference),
                   "profileDigest": digest(reference), "implementationDigest": implementation_digest(),
                   "simGpus": "1", "simGpuMemGB": "12", "renderer": "vulkan"},
    }


def configure_policy(args, reference):
    model = json.loads((HERE / "profiles/robotwin-openpi.json").read_text())
    check_source(args.openpi_source, model["source"], model["source"]["files"])
    if (model["nativeProfile"] != reference["benchmarkProfile"]["id"]
            or model["replanSteps"] != reference["parameters"]["replanSteps"]):
        raise ValueError("RoboTwin and OpenPI recipes differ")

    checkpoint = model["checkpoint"]
    if (tree_digest(args.weights) != checkpoint["digest"]
            or tree_digest(args.weights / "assets") != checkpoint["normalizationDigest"]):
        raise ValueError("RoboTwin checkpoint differs from the published inference files")

    name = "pi05-robotwin-adjust-bottle"
    service = {
        "name": "policy", "image": image_id(args.policy_image), "cpus": 4, "memGB": 32, "gpuMemGB": 32,
        "env": {"JAX_PLATFORMS": "cuda", "XLA_PYTHON_CLIENT_PREALLOCATE": "false"},
        "command": ["/opt/orbit/serve_openpi.py", "--config", checkpoint["config"], "--checkpoint", "/weights",
                    "--checkpoint-digest", checkpoint["digest"], "--normalization-digest", checkpoint["normalizationDigest"]],
        "healthcheck": {
            "command": ["/.venv/bin/python", "-c",
                        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5).read()"],
            "intervalSec": 10, "timeoutSec": 6, "startPeriodSec": 300, "retries": 90,
        },
    }
    service.update({"gpusOf": "main", "gpus": 0} if args.share_gpu else {"role": "policy", "gpus": 1})
    return {
        "name": name + ("-shared" if args.share_gpu else ""), "version": "1",
        "connector": "openpi-ws", "ioAdapter": "robotwin-native", "replanSteps": model["replanSteps"],
        "profile": {**reference["benchmarkProfile"], "id": model["profileId"]},
        "checkpointDigest": checkpoint["digest"], "normalizationDigest": checkpoint["normalizationDigest"],
        "randomness": model["randomness"], "weights": {"dataset": name, "target": "/weights"},
        "service": service,
    }


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="endpoint", required=True)
    benchmark = commands.add_parser("benchmark")
    benchmark.add_argument("--robotwin-source", type=Path, required=True)
    benchmark.add_argument("--assets", type=Path, required=True)
    benchmark.add_argument("--benchmark-image", required=True)
    benchmark.add_argument("--output-dir", type=Path, required=True)
    policy = commands.add_parser("policy")
    policy.add_argument("--openpi-source", type=Path, required=True)
    policy.add_argument("--weights", type=Path, required=True)
    policy.add_argument("--policy-image", required=True)
    policy.add_argument("--share-gpu", action="store_true")
    policy.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    reference = json.loads((HERE / "profiles/robotwin-demo-clean.json").read_text())
    if args.endpoint == "benchmark":
        outputs = {"benchmark.json": configure_benchmark(args, reference), "reference.json": reference}
    else:
        outputs = {"policy.json": configure_policy(args, reference)}
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for filename, value in outputs.items():
        (args.output_dir / filename).write_text(json.dumps(value, indent=2) + "\n")
    print("Wrote the pinned RoboTwin " + args.endpoint + " registration.")


if __name__ == "__main__":
    main()
