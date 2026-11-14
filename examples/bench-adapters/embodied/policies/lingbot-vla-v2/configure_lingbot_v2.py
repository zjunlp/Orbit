"""Register LingBot-VLA 2.0 for native RoboTwin 2.0 joint control."""

import argparse
import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import HERE
from native_runtime import MANIFEST_LABEL, policy_manifest, require_image
from serve_lingbot_v2 import CHUNK, RANDOMNESS, asset_digests


NAME = "lingbot-vla-v2-robotwin"
ROBOTWIN_REVISION = "13c3c47ff4312dd62484bcd51be034af55c062d1"
CHECKPOINT = "54f79a4b6e9166bda91b5010088097ff3191bca2"
LEROBOT = "410c095eacc0011d998a73383eb94abed2715af0"
DOCKERFILE = Path(__file__).with_name("policy.Dockerfile")


def native_profile(reference, *, allow_other_revision=False):
    profile = reference["benchmarkProfile"]
    native = json.loads((HERE / "profiles/robotwin-demo-clean.json").read_text())["benchmarkProfile"]
    if (reference["environment"]["kind"] != "robotwin" or profile != native
            or reference["observationMap"] != {name: name for name in native["observations"]}
            or reference["parameters"]["replanSteps"] != CHUNK):
        raise ValueError("expected the native RoboTwin fifty-step joint-control recipe")
    if not allow_other_revision and reference["reference"]["evaluation"]["commit"] != ROBOTWIN_REVISION:
        raise ValueError("official reproduction requires RoboTwin " + ROBOTWIN_REVISION
                         + "; use --allow-other-revision for a cross-revision experiment")
    return {**profile, "id": NAME + "-joint-input/1"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--build-tag")
    operation.add_argument("--policy-image")
    parser.add_argument("--policy-base")
    parser.add_argument("--reference-file", type=Path)
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--allow-other-revision", action="store_true",
                        help="generate a policy from a semantically compatible RoboTwin revision")
    args = parser.parse_args()
    if args.build_tag and not args.policy_base:
        parser.error("--build-tag requires --policy-base (the LeRobot 0.7.0 runtime)")
    if args.policy_image and not all((args.reference_file, args.weights, args.output)):
        parser.error("--policy-image requires --reference-file, --weights and --output")
    manifest = policy_manifest(NAME, {"lerobot": {"commit": LEROBOT}, "checkpoint": {"commit": CHECKPOINT}},
                               DOCKERFILE, DOCKERFILE.with_name("serve_lingbot_v2.py"))
    if args.build_tag:
        label = MANIFEST_LABEL + "=" + json.dumps(manifest, separators=(",", ":"))
        subprocess.run(["docker", "build", "--label", "orbit.task=embodied-eval", "--label", label,
                        "--build-arg", "POLICY_BASE=" + args.policy_base,
                        "-f", str(DOCKERFILE), "-t", args.build_tag, str(HERE.parents[2])], check=True)
        return
    image = require_image(args.policy_image, manifest)
    profile = native_profile(json.loads(args.reference_file.read_text()),
                             allow_other_revision=args.allow_other_revision)
    checkpoint, normalization = asset_digests(args.weights)
    registration = {
        "name": NAME, "version": "2.0", "connector": "policy-ws", "replanSteps": CHUNK, "callTimeoutSec": 300,
        "profile": profile, "checkpointDigest": checkpoint, "normalizationDigest": normalization,
        "randomness": RANDOMNESS, "weights": {"dataset": NAME, "target": "/weights"},
        "service": {
            "name": "policy", "image": image, "gpusOf": "main", "gpus": 0,
            "gpuMemGB": 34, "memGB": 42, "cpus": 8,
            "command": ["--weights", "/weights", "--checkpoint-digest", checkpoint,
                        "--normalization-digest", normalization],
            "healthcheck": {"command": ["python", "-c",
                                        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5).read()"],
                            "intervalSec": 10, "timeoutSec": 6, "startPeriodSec": 300, "retries": 90},
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(registration, indent=2) + "\n")


if __name__ == "__main__":
    main()
