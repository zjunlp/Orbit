"""Build or register the Xiaomi-Robotics-1 RoboCasa365 policy and native protocol."""

import argparse
from copy import deepcopy
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import file_digest
from benchmarks.robocasa365.configure_robocasa365 import panda_omron_v101_reference, set_benchmark_scope
from native_runtime import build_policy_image, check_policy_source, image_id, policy_manifest, require_image, write_benchmark
from serve_xiaomi import RANDOMNESS, REPLAN, asset_identity

SOURCE = {"repository": "https://github.com/XiaomiRobotics/Xiaomi-Robotics-1",
          "commit": "0dd7aef8dc87296246aae812a1f59ccb708e5546"}
HERE_POLICY = Path(__file__).resolve().parent
SERVER = HERE_POLICY / "serve_xiaomi.py"
DOCKERFILE = HERE_POLICY / "policy.Dockerfile"
RELEASE = HERE_POLICY / "release.json"
NAME = "xiaomi-robotics-1-robocasa365"


def benchmark_reference(robocasa, assets):
    reference = panda_omron_v101_reference(robocasa, assets, SOURCE)
    reference["parameters"].update(environmentSeed=7, replanSteps=REPLAN, successRule="last")
    environment = reference["environment"]
    environment.update(protocol="xiaomi-robotics-1", environmentSeed=7, horizonScale=1)
    profile = reference["benchmarkProfile"]
    profile["id"] = "robocasa365-panda-omron-history4-stride2/1"
    for field in profile["observations"].values():
        if field["dtype"] != "string":
            field["shape"] = [4, *field["shape"]]
            if field["semantic"] == "rgb":
                field["layout"] = "THWC"
    return reference


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--build-tag")
    operation.add_argument("--policy-image")
    operation.add_argument("--benchmark-only", action="store_true")
    parser.add_argument("--policy-base")
    parser.add_argument("--benchmark-image")
    parser.add_argument("--robocasa-source", type=Path)
    parser.add_argument("--assets", type=Path)
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    check_policy_source(args.source, SOURCE)
    manifest = policy_manifest(NAME, {"xiaomi": SOURCE}, DOCKERFILE, SERVER)
    manifest["release"] = file_digest(RELEASE)
    if args.build_tag:
        if not args.policy_base:
            parser.error("--build-tag requires --policy-base")
        manifest["base"] = image_id(args.policy_base)
        build_policy_image(args, "xiaomi", SOURCE, DOCKERFILE, manifest, source_paths=("deploy", "eval_robocasa365"))
        return
    if not all((args.benchmark_image, args.robocasa_source, args.assets, args.output_dir)):
        parser.error("registration requires --benchmark-image, --robocasa-source, --assets and --output-dir")
    if args.policy_image and not (args.policy_base and args.weights):
        parser.error("--policy-image requires --policy-base and --weights")
    reference = benchmark_reference(args.robocasa_source, args.assets)
    benchmark_image = image_id(args.benchmark_image)
    policy = None
    if args.policy_image:
        manifest["base"] = image_id(args.policy_base)
        image = require_image(args.policy_image, manifest)
        checkpoint, normalization = asset_identity(args.weights, json.loads(RELEASE.read_text()))
        policy = policy_definition(reference, image, checkpoint, normalization)
    for scope in ("target50", "atomic_seen", "composite_seen", "composite_unseen"):
        condition = deepcopy(reference)
        name = set_benchmark_scope(condition, args.robocasa_source, scope, "pretrain", "xiaomi-robotics-1")
        environment = condition["environment"]
        environment["taskIndexes"] = {task: index for index, task in enumerate(environment["tasks"])}
        environment["initialStateCounts"] = {task: 50 for task in environment["tasks"]}
        write_benchmark(args.output_dir, name, args.robocasa_source, benchmark_image, "egl",
                        "/usr/local/bin/python", condition, gpu_mem=4)
    if policy:
        (args.output_dir / "policy.json").write_text(json.dumps(policy, indent=2) + "\n")


def policy_definition(reference, image, checkpoint, normalization):
    return {
        "name": NAME, "version": "1", "connector": "policy-ws", "replanSteps": REPLAN,
        "callTimeoutSec": 180, "randomness": RANDOMNESS,
        "profile": {**reference["benchmarkProfile"], "id": NAME + "/1"},
        "checkpointDigest": checkpoint, "normalizationDigest": normalization,
        "weights": {"dataset": NAME, "target": "/weights"},
        "service": {"name": "policy", "image": image, "gpusOf": "main", "gpus": 0,
                    "gpuMemGB": 14, "memGB": 24, "cpus": 4,
                    "command": ["--weights", "/weights", "--checkpoint-digest", checkpoint,
                                "--normalization-digest", normalization],
                    "healthcheck": {"command": ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5).read()"],
                                    "intervalSec": 10, "timeoutSec": 6, "startPeriodSec": 180, "retries": 30}},
    }


if __name__ == "__main__":
    main()
