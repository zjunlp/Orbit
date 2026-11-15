"""Build or register the released LightNav-0 checkpoint for HSSD-OV."""

import argparse
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))

from adapter import file_digest
from native_runtime import build_policy_image, check_policy_source, image_id, policy_manifest, require_image
from orbit_embodied.conversions import LIGHTNAV_HSSD_VELOCITY
from orbit_embodied.hssd_ov import semantic_profile
from serve_lightnav import RANDOMNESS, RELEASE, identity

SOURCE = {"repository": "https://github.com/lightorigins/LightNav-0",
          "commit": "3015508b70fb6e30bbd66701e94c9b916dcb8df8"}
NAME = "lightnav-0-hssd-ov"
DOCKERFILE = HERE / "policy.Dockerfile"
SERVER = HERE / "serve_lightnav.py"


def definition(image, assets):
    profile = semantic_profile()
    del profile["observations"]["agent_position"]
    profile["id"] = NAME + "/1"
    return {
        "name": NAME, "version": "2", "connector": "policy-ws", "replanSteps": 1,
        "actionConversion": LIGHTNAV_HSSD_VELOCITY,
        "callTimeoutSec": 120, "randomness": RANDOMNESS, "profile": profile, **assets,
        "weights": {"dataset": NAME, "target": "/weights"},
        "service": {"name": "policy", "image": image, "gpusOf": "main", "memGB": 24, "cpus": 4,
                    "command": ["--weights", "/weights", "--checkpoint-digest", assets["checkpointDigest"],
                                "--normalization-digest", assets["normalizationDigest"]],
                    "healthcheck": {"command": ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5).close()"],
                                    "intervalSec": 5, "timeoutSec": 6, "startPeriodSec": 180, "retries": 40}},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--policy-base", default="pytorch/pytorch:2.9.0-cuda12.6-cudnn9-runtime")
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--output-dir", type=Path)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--build-tag")
    operation.add_argument("--policy-image")
    args = parser.parse_args()
    check_policy_source(args.source, SOURCE)
    manifest = policy_manifest(NAME, {"lightnav": SOURCE}, DOCKERFILE, SERVER)
    manifest.update(base=image_id(args.policy_base), release=file_digest(RELEASE))
    if args.build_tag:
        build_policy_image(args, "lightnav", SOURCE, DOCKERFILE, manifest,
                           source_paths=("pyproject.toml", "README.md", "LICENSE", "src"))
        return
    if args.weights is None or args.output_dir is None:
        parser.error("--policy-image requires --weights and --output-dir")
    image = require_image(args.policy_image, manifest)
    policy = definition(image, identity(args.weights, json.loads(RELEASE.read_text())))
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / (NAME + ".json")).write_text(json.dumps(policy, indent=2) + "\n")


if __name__ == "__main__":
    main()
