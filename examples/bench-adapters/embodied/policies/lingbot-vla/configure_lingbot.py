"""Register LingBot-VLA against a frozen native RoboTwin joint-control profile."""

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import file_digest
from native_runtime import build_policy_image, check_policy_source, policy_manifest, require_image
from orbit_embodied.assets import tree_digest


SOURCE = {"repository": "https://github.com/robbyant/lingbot-vla",
          "commit": "4eb34b7693a0565c67433f8fac9c59a2e67eb60b"}
NORM = "assets/norm_stats/robotwin_50.json"
POLICY = Path(__file__).resolve().parent
DOCKERFILE = POLICY / "policy.Dockerfile"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--build-tag")
    operation.add_argument("--policy-image")
    parser.add_argument("--policy-base")
    parser.add_argument("--reference-file", type=Path)
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.build_tag and not args.policy_base:
        parser.error("--build-tag requires --policy-base")
    if args.policy_image and not all((args.reference_file, args.weights, args.output)):
        parser.error("--policy-image requires --reference-file, --weights and --output")
    check_policy_source(args.source, SOURCE)
    manifest = policy_manifest("lingbot-vla-policy", {"lingbot": SOURCE}, DOCKERFILE, POLICY / "serve_lingbot.py")
    if args.build_tag:
        build_policy_image(args, "lingbot", SOURCE, DOCKERFILE, manifest)
        return
    image = require_image(args.policy_image, manifest)
    reference = json.loads(args.reference_file.read_text())
    profile = reference["benchmarkProfile"]
    if profile["id"] != "robotwin-aloha-agilex-native/1" or reference["parameters"]["replanSteps"] != 50:
        raise ValueError("expected the native RoboTwin fifty-step joint-control recipe")
    required = ("policy/config.json", "policy/lingbotvla_cli.yaml", "policy/model.safetensors",
                "qwen/config.json", "qwen/tokenizer.json", "qwen/preprocessor_config.json")
    if not all((args.weights / path).is_file() for path in required):
        raise ValueError("LingBot-VLA checkpoint or Qwen processor is incomplete")
    checkpoint, normalization = tree_digest(args.weights), file_digest(args.source / NORM)
    name = "lingbot-vla-4b-robotwin"
    registration = {
        "name": name, "version": "1", "connector": "policy-ws", "replanSteps": 50, "callTimeoutSec": 300,
        "profile": {**profile, "id": "lingbot-vla-robotwin-joint-input/1"},
        "checkpointDigest": checkpoint, "normalizationDigest": normalization,
        "randomness": {"backend": "torch", "initialSeed": 0, "scope": "service"},
        "weights": {"dataset": name, "target": "/weights"},
        "service": {
            "name": "policy", "image": image, "gpusOf": "main", "gpus": 0,
            "gpuMemGB": 30, "memGB": 32, "cpus": 4,
            "command": ["--weights", "/weights", "--checkpoint-digest", checkpoint, "--normalization-digest", normalization],
            "healthcheck": {"command": ["python", "-c",
                                        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5).read()"],
                            "intervalSec": 10, "timeoutSec": 6, "startPeriodSec": 300, "retries": 90},
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(registration, indent=2) + "\n")


if __name__ == "__main__":
    main()
