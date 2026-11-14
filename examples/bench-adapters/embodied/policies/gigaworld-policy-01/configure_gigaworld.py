"""Build or register GigaWorld-Policy-0.1 and its native RoboCasa365 protocol."""

import argparse
from copy import deepcopy
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import file_digest
from benchmarks.robocasa365.configure_robocasa365 import panda_omron_v101_reference, set_benchmark_scope
from native_runtime import build_policy_image, check_policy_source, image_id, policy_manifest, require_image, write_benchmark
from serve_gigaworld import RANDOMNESS, REPLAN, asset_identity


SOURCE = {"repository": "https://github.com/buyaojinchang/gigaworld_policy_01_robocasa_multi-task",
          "commit": "b9e491965584963b62c31115d8b6416851c155ef"}
RECIPE = "gigaworld-policy-01"
NAME = RECIPE + "-robocasa365"
HERE_POLICY = Path(__file__).resolve().parent
SERVER = HERE_POLICY / "serve_gigaworld.py"
DOCKERFILE = HERE_POLICY / "policy.Dockerfile"
RELEASE = HERE_POLICY / "release.json"


def policy_definition(reference, image, identity):
    return {
        "name": NAME, "version": "1", "connector": "policy-ws", "replanSteps": REPLAN,
        "callTimeoutSec": 180, "randomness": RANDOMNESS,
        "profile": {**reference["benchmarkProfile"], "id": NAME + "/1"}, **identity,
        "weights": {"dataset": NAME, "target": "/weights"},
        "service": {"name": "policy", "image": image, "gpusOf": "main", "gpus": 0,
                    "gpuMemGB": 36, "memGB": 48, "cpus": 8,
                    "command": ["--weights", "/weights", "--checkpoint-digest", identity["checkpointDigest"],
                                "--normalization-digest", identity["normalizationDigest"],
                                "--backbone-digest", identity["backboneDigest"]],
                    "healthcheck": {"command": ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5).read()"],
                                    "intervalSec": 10, "timeoutSec": 6, "startPeriodSec": 300, "retries": 60}},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--build-tag")
    operation.add_argument("--policy-image")
    operation.add_argument("--benchmark-only", action="store_true")
    parser.add_argument("--policy-base")
    parser.add_argument("--policy-wheels", type=Path, help="Optional offline wheel directory for the image build")
    parser.add_argument("--benchmark-image")
    parser.add_argument("--robocasa-source", type=Path)
    parser.add_argument("--assets", type=Path)
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    check_policy_source(args.source, SOURCE)
    if (args.build_tag or args.policy_image) and not args.policy_base:
        parser.error("policy build and registration require --policy-base")
    manifest = policy_manifest(NAME, {"gigaworld": SOURCE}, DOCKERFILE, SERVER)
    manifest["release"] = file_digest(RELEASE)
    if args.policy_base:
        manifest["base"] = image_id(args.policy_base)
    if args.build_tag:
        wheels = (("wheelhouse", args.policy_wheels.resolve()),) if args.policy_wheels else ()
        build_policy_image(args, "gigaworld", SOURCE, DOCKERFILE, manifest, source_paths=("src", "experiment"),
                           extra_contexts=wheels, build_args=("OFFLINE_WHEELS=1",) if wheels else ())
        return
    if not all((args.benchmark_image, args.robocasa_source, args.assets, args.output_dir)):
        parser.error("registration requires --benchmark-image, --robocasa-source, --assets and --output-dir")
    if args.policy_image and not args.weights:
        parser.error("--policy-image requires --weights")
    reference = panda_omron_v101_reference(args.robocasa_source, args.assets, SOURCE)
    reference["parameters"].update(replanSteps=REPLAN, environmentSeed=7, successRule="last")
    reference["environment"].update(protocol=RECIPE, environmentSeed=7)
    benchmark_image = image_id(args.benchmark_image)
    policy = None
    if args.policy_image:
        image = require_image(args.policy_image, manifest)
        identity = asset_identity(args.weights, json.loads(RELEASE.read_text()))
        policy = policy_definition(reference, image, identity)
    for scope in ("target50", "atomic_seen", "composite_seen", "composite_unseen"):
        condition = deepcopy(reference)
        name = set_benchmark_scope(condition, args.robocasa_source, scope, "pretrain", RECIPE)
        environment = condition["environment"]
        environment["initialStateCounts"] = dict.fromkeys(environment["tasks"], 50)
        write_benchmark(args.output_dir, name, args.robocasa_source, benchmark_image, "egl",
                        "/usr/local/bin/python", condition, gpu_mem=4)
    if policy:
        (args.output_dir / "policy.json").write_text(json.dumps(policy, indent=2) + "\n")


if __name__ == "__main__":
    main()
