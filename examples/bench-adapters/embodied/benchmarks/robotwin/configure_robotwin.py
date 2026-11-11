"""Generate independent local registrations for RoboTwin and the published OpenPI recipe."""

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import HERE, check_source, digest, file_digest, implementation_digest
from native_runtime import image_id
from orbit_embodied.assets import tree_digest


def configure_benchmark(args, reference):
    source = reference["reference"]
    environment = reference["environment"]
    suites = json.loads((HERE / "profiles/robotwin-suites.json").read_text()) if args.suite else None
    if args.suite == "demo_randomized":
        source["files"]["task_config/demo_randomized.yml"] = suites["randomizedConfig"]
        source["assets"]["archives"]["background_texture.zip"] = suites["backgroundArchive"]
    check_source(args.robotwin_source, source["evaluation"], source["files"])
    asset_digest = tree_digest(args.assets)
    if args.suite:
        if asset_digest != suites["assetDigests"][args.suite]:
            raise ValueError("RoboTwin suite needs the full assets prepared for " + args.suite)
        # The upstream list contains exactly the benchmark tasks and their native evaluation limits.
        # It is a pinned flat YAML mapping, so registration needs no host YAML dependency.
        limits = (args.robotwin_source / "task_config/_eval_step_limit.yml").read_text()
        horizons = {}
        for line in limits.splitlines():
            entry = re.fullmatch(r"([a-z][a-z0-9_]*): ([1-9][0-9]*)", line)
            if not entry or entry[1] in horizons:
                raise ValueError("invalid RoboTwin evaluation limit: " + line)
            horizons[entry[1]] = int(entry[2])
        if len(horizons) != 50:
            raise ValueError("expected the 50 official RoboTwin tasks")
        subprocess.run(["git", "-C", str(args.robotwin_source), "diff", "--exit-code", "--quiet", "HEAD",
                        "--", "envs", "description", "task_config"], check=True)
        for task in horizons:
            for relative in (f"envs/{task}.py", f"description/task_instruction/{task}.json"):
                source["files"][relative] = file_digest(args.robotwin_source / relative)
        suite_name = args.suite.replace("_", "-")
        reference.update(id=f"robotwin-2.0-{suite_name}/2", scoreUnit="task")
        environment.update(suite=args.suite, tasks=list(horizons), horizons=horizons)
        environment["assets"]["dataset"] = f"robotwin-{suite_name}-full-assets"
    environment["assets"]["digest"] = asset_digest
    suffix = "-full-native" if args.suite else "-native"
    return {
        "name": "robotwin-" + environment["suite"].replace("_", "-") + suffix,
        "adapter": str(HERE / "adapter.py"),
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
    benchmark.add_argument("--suite", choices=("demo_clean", "demo_randomized"),
                           help="register all tasks for this suite; omit for the legacy adjust_bottle recipe")
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
