"""Build or register the pinned DM0.5 VLA-Arena policy."""

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import file_digest
from native_runtime import build_policy_image, check_policy_source, policy_manifest, require_image
from orbit_embodied.assets import tree_digest
from orbit_embodied.binding import resolve_binding


SOURCE = {"repository": "https://github.com/dexmal/opendm",
          "commit": "03f799120d425ead51d9482bb1da950b6dabade9"}
HERE = Path(__file__).resolve().parent
DOCKERFILE = HERE / "policy.Dockerfile"


def policy_profile(reference):
    benchmark, environment = reference["benchmarkProfile"], reference["environment"]
    if (benchmark["id"] != "vla-arena-panda-raw/1" or environment["kind"] != "vla-arena"
            or environment.get("protocol") != "dm05" or reference["parameters"]["replanSteps"] != 10):
        raise ValueError("expected the native VLA-Arena DM0.5 recipe")
    profile = json.loads((HERE / "profile.json").read_text())
    resolve_binding(benchmark, profile, reference["observationMap"])
    return profile


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
    manifest = policy_manifest("dm05-vla-arena-policy", {"opendm": SOURCE}, DOCKERFILE, HERE / "serve_dm05.py")
    if args.build_tag:
        build_policy_image(args, "opendm", SOURCE, DOCKERFILE, manifest,
                           source_paths=("opendm", "playground/dm05_vla_arena.py", "pyproject.toml", "README.md", "LICENSE"))
        return
    image = require_image(args.policy_image, manifest)
    reference = json.loads(args.reference_file.read_text())
    profile = policy_profile(reference)
    required = ("config.json", "model.safetensors", "norm_stats.json", "tokenizer.json",
                "tokenizer_config.json", "processor_config.json", "chat_template.jinja")
    if not all((args.weights / path).is_file() for path in required):
        raise ValueError("DM0.5 Arena checkpoint, processor, or normalization is incomplete")
    checkpoint = tree_digest(args.weights)
    normalization = file_digest(args.weights / "norm_stats.json")
    name = "dm05-vla-arena"
    registration = {
        "name": name, "version": "1", "connector": "policy-ws", "replanSteps": 10,
        "profile": profile,
        "checkpointDigest": checkpoint, "normalizationDigest": normalization,
        "randomness": {"backend": "torch", "initialSeed": 0, "scope": "service"},
        "weights": {"dataset": name, "target": "/weights"},
        "service": {
            "name": "policy", "image": image, "role": "policy", "gpus": 1, "gpuMemGB": 26,
            "memGB": 24, "cpus": 4,
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
