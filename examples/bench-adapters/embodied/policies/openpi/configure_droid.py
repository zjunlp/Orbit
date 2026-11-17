"""Register the OpenPI DROID baseline independently of its MolmoSpaces benchmark."""

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import file_digest
from native_runtime import build_policy_image, check_policy_source, policy_manifest, require_image
from orbit_embodied.assets import checkpoint_tree_digest
from orbit_embodied.binding import resolve_binding


SOURCE = {"repository": "https://github.com/omarrayyann/openpi",
          "commit": "711487f019e5f03b254d427d4523b1f0805a4814"}
POLICY = Path(__file__).resolve().parent
DOCKERFILE = POLICY / "droid-policy.Dockerfile"
INTERPRETER = "/.venv/bin/python"
WEIGHTS_DATASET = "pi05-droid-molmospaces"
RANDCAM_CAMERA = "randomized_zed2_analogue_1"
RANDCAM_PROFILE = "pi05-droid-jointpos-randcam-input/1"


def policy_profile(reference):
    benchmark, environment = reference["benchmarkProfile"], reference["environment"]
    randcam = benchmark["id"] == "molmospaces-franka-droid-exocentric/1"
    if (environment["kind"] != "molmospaces"
            or benchmark["id"] not in ("molmospaces-franka-droid/1", "molmospaces-franka-droid-exocentric/1")
            or reference["parameters"]["replanSteps"] != 8):
        raise ValueError("expected the frozen eight-step MolmoSpaces DROID recipe")
    profile = json.loads((POLICY / "droid-profile.json").read_text())
    if randcam:
        if environment.get("frontCamera") != RANDCAM_CAMERA:
            raise ValueError("expected the published MolmoBot RandCam exocentric camera")
        profile["id"] = RANDCAM_PROFILE
        profile["observations"]["front_rgb"]["camera"] = RANDCAM_CAMERA
    elif environment.get("frontCamera") is not None:
        raise ValueError("the standard MolmoSpaces DROID recipe requires the native shoulder camera")
    resolve_binding(benchmark, profile, reference["observationMap"])
    return profile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--build-tag")
    operation.add_argument("--policy-image")
    parser.add_argument("--source", type=Path)
    parser.add_argument("--policy-base")
    parser.add_argument("--wire-wheels", type=Path)
    parser.add_argument("--reference-file", type=Path)
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--share-gpu", action="store_true",
                        help="run the policy on the simulator GPU (requires a GPU simulator)")
    args = parser.parse_args()
    manifest = policy_manifest("openpi-droid-policy", {"openpi": SOURCE}, DOCKERFILE, POLICY / "serve_droid.py",
                               interpreter=INTERPRETER)
    if args.build_tag:
        if not all((args.source, args.policy_base, args.wire_wheels)):
            parser.error("--build-tag requires --source, --policy-base and --wire-wheels")
        check_policy_source(args.source, SOURCE)
        build_policy_image(args, "openpi", SOURCE, DOCKERFILE, manifest,
                           source_paths=("src", "packages/openpi-client"),
                           extra_contexts=(("wire_wheels", args.wire_wheels.resolve()),))
        return
    if not all((args.reference_file, args.weights, args.output)):
        parser.error("--policy-image requires --reference-file, --weights and --output")
    image = require_image(args.policy_image, manifest)
    reference = json.loads(args.reference_file.read_text())
    profile = policy_profile(reference)
    if not (args.weights / "params/manifest.ocdbt").is_file() or list(args.weights.rglob("*.partial")):
        raise ValueError("DROID checkpoint download is incomplete")
    checkpoint = checkpoint_tree_digest(args.weights)
    normalization = file_digest(args.weights / "assets/droid/norm_stats.json")
    name = WEIGHTS_DATASET + "-randcam" if profile["id"] == RANDCAM_PROFILE else WEIGHTS_DATASET
    placement = {"gpusOf": "main", "gpus": 0} if args.share_gpu else {"role": "policy", "gpus": 1}
    policy = {
        "name": name, "version": "1", "connector": "policy-ws", "replanSteps": 8,
        "profile": profile,
        "checkpointDigest": checkpoint, "normalizationDigest": normalization,
        "randomness": {"backend": "jax", "initialKey": 0, "scope": "service"},
        "weights": {"dataset": WEIGHTS_DATASET, "target": "/weights"},
        "service": {
            "name": "policy", "image": image, **placement,
            "gpuMemGB": 32, "memGB": 32, "cpus": 4,
            "env": {"JAX_PLATFORMS": "cuda", "XLA_PYTHON_CLIENT_PREALLOCATE": "false"},
            "command": ["--checkpoint", "/weights", "--checkpoint-digest", checkpoint,
                        "--normalization-digest", normalization],
            "healthcheck": {"command": [INTERPRETER, "-c",
                                        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5).read()"],
                            "intervalSec": 10, "timeoutSec": 6, "startPeriodSec": 300, "retries": 90},
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(policy, indent=2) + "\n")


if __name__ == "__main__":
    main()
