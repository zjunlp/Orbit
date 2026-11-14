"""Build or register the matched SeeNav-Agent and original Qwen2.5-VL policies."""

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import file_digest
from native_runtime import build_policy_image, check_policy_source, image_id, policy_manifest, require_image
from orbit_embodied.eb_navigation import semantic_profile
from serve_seenav import RANDOMNESS, RELEASE, asset_identity

SOURCE = {"repository": "https://github.com/WzcTHU/SeeNav-Agent",
          "commit": "7ed6a59052701951bdb2c7d51dd6d9103219cf3e"}
HERE = Path(__file__).resolve().parent
DOCKERFILE = HERE / "policy.Dockerfile"
SERVER = HERE / "serve_seenav.py"
NAME = "seenav-eb-navigation"


def policy_definition(model, image, identity):
    name = model + "-eb-navigation"
    profile = semantic_profile()
    del profile["observations"]["navigation_pose"]
    profile["id"] = name + "/1"
    return {
        "name": name, "version": "1", "connector": "policy-ws", "replanSteps": 1,
        "callTimeoutSec": 180, "randomness": RANDOMNESS, "profile": profile, **identity,
        "weights": {"dataset": name, "target": "/weights"},
        "service": {"name": "policy", "image": image, "gpusOf": "main", "gpus": 0,
                    "memGB": 24, "cpus": 4,
                    "command": ["--model", model, "--weights", "/weights",
                                "--checkpoint-digest", identity["checkpointDigest"],
                                "--normalization-digest", identity["normalizationDigest"]],
                    "healthcheck": {"command": ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5).close()"],
                                    "intervalSec": 5, "timeoutSec": 6, "startPeriodSec": 180, "retries": 40}},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--policy-base", default="pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime")
    parser.add_argument("--model", choices=tuple(json.loads(RELEASE.read_text())))
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--output-dir", type=Path)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--build-tag")
    operation.add_argument("--policy-image")
    args = parser.parse_args()
    check_policy_source(args.source, SOURCE)
    manifest = policy_manifest(NAME, {"seenav": SOURCE}, DOCKERFILE, SERVER)
    manifest.update(release=file_digest(RELEASE), base=image_id(args.policy_base))
    if args.build_tag:
        build_policy_image(args, "seenav", SOURCE, DOCKERFILE, manifest, source_paths=(
            "SeeNav/planner/EBNavPlanner.py", "SeeNav/planner/utils/EBNav_planner_utils.py",
            "SeeNav/envs/utils/EBNav_env_utils.py"))
        return
    if not all((args.model, args.weights, args.output_dir)):
        parser.error("--policy-image requires --model, --weights and --output-dir")
    image = require_image(args.policy_image, manifest)
    identity = asset_identity(args.weights, json.loads(RELEASE.read_text())[args.model])
    policy = policy_definition(args.model, image, identity)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / (policy["name"] + ".json")).write_text(json.dumps(policy, indent=2) + "\n")


if __name__ == "__main__":
    main()
