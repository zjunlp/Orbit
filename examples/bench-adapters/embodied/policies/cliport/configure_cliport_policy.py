"""Build or register the released multi-language-conditioned CLIPort policy."""

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from native_runtime import build_policy_image, check_policy_source, image_id, policy_manifest, require_image
from orbit_embodied.binding import resolve_binding
from orbit_embodied.cliport import profile
from serve_cliport import BACKBONE_DIGEST, CHECKPOINT_DIGEST, CONFIG_DIGEST, check_weights


SOURCE = {"repository": "https://github.com/cliport/cliport",
          "commit": "2be5c47b5bb9bb7040ad90693288b87b1e18e7ad"}
HERE = Path(__file__).resolve().parent
NAME = "cliport-multi-language"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--policy-base", default="pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--build-tag")
    mode.add_argument("--policy-image")
    parser.add_argument("--reference-file", type=Path)
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    check_policy_source(args.source, SOURCE)
    dockerfile = HERE / "policy.Dockerfile"
    manifest = policy_manifest(NAME, {"cliport": SOURCE}, dockerfile, HERE / "serve_cliport.py")
    manifest["base"] = image_id(args.policy_base)
    if args.build_tag:
        build_policy_image(args, "cliport", SOURCE, dockerfile, manifest, source_paths=("cliport",))
        return
    if not all((args.reference_file, args.weights, args.output)):
        parser.error("registration requires --reference-file, --weights and --output")
    image = require_image(args.policy_image, manifest)
    check_weights(args.weights)
    reference = json.loads(args.reference_file.read_text())
    if reference["environment"]["kind"] != "cliport" or reference["parameters"]["replanSteps"] != 1:
        raise ValueError("expected the CLIPort native test recipe")
    primitive = reference["environment"].get("primitive")
    if primitive not in ("pick-place", "push"):
        raise ValueError("regenerate the CLIPort benchmark registration with its native primitive")
    policy_profile = profile("policy", primitive)
    name, version = (NAME, "3") if primitive == "pick-place" else (NAME + "-push", "1")
    resolve_binding(reference["benchmarkProfile"], policy_profile, reference["observationMap"])
    definition = {
        "name": name, "version": version, "connector": "policy-ws", "replanSteps": 1,
        "profile": policy_profile, "checkpointDigest": CHECKPOINT_DIGEST, "normalizationDigest": CONFIG_DIGEST,
        "backboneDigest": BACKBONE_DIGEST, "randomness": {"backend": "stateless", "scope": "stateless"},
        "weights": {"dataset": NAME, "target": "/weights"},
        "service": {"name": "policy", "image": image, "role": "policy", "gpus": 1, "gpuMemGB": 14,
                    "memGB": 12, "cpus": 4, "command": ["--weights", "/weights", "--primitive", primitive],
                    "healthcheck": {"command": ["python", "-c",
                                                "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5).read()"],
                                    "intervalSec": 10, "timeoutSec": 6, "startPeriodSec": 180, "retries": 30}},
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(definition, indent=2) + "\n")


if __name__ == "__main__":
    main()
