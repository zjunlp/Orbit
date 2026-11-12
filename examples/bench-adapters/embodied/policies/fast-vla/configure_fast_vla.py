"""Build or register the pinned Fast-VLA RoboTwin policy."""

import argparse
import json
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import digest, file_digest
from native_runtime import build_policy_image, check_policy_source, export_source, policy_manifest, require_image
from orbit_embodied.assets import tree_digest
from orbit_embodied.binding import resolve_binding


FAST_VLA = {"repository": "https://github.com/Garfield-kh/FastVLA",
            "commit": "ad69ea0f32595801a015dfbd70fb77876d694752"}
OPEN_DM = {"repository": "https://github.com/dexmal/opendm",
           "commit": "e41e501bb82e9c3cb8138c0fb4687faa5f98c690"}
DM05_REVISION = "bef09062f8d9744b7691d0a5db4e23834e46071e"
DINO_REVISION = "f9e44c814b77203eaa57a6bdbbd535f21ede1415"
DINO = Path("hub/models--facebook--dinov2-base")
DINO_CONFIG = DINO / "snapshots" / DINO_REVISION / "config.json"
DINO_DIGEST = "sha256:f7ff4cfa73d2f70647dbf6950541ad25d73082d54c2e7e9bded160c7656b2a70"
HERE = Path(__file__).resolve().parent
DOCKERFILE = HERE / "policy.Dockerfile"


def policy_profile(reference):
    benchmark, environment = reference["benchmarkProfile"], reference["environment"]
    if (benchmark["id"] != "robotwin-aloha-agilex-head-history/1" or environment["kind"] != "robotwin"
            or environment.get("headCameraHistorySteps") != [17, 8] or reference["parameters"]["replanSteps"] != 50):
        raise ValueError("expected the native RoboTwin Fast-VLA history recipe")
    profile = json.loads((HERE / "profile.json").read_text())
    resolve_binding(benchmark, profile, reference["observationMap"])
    return profile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--opendm-source", type=Path, required=True)
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
    check_policy_source(args.source, FAST_VLA)
    check_policy_source(args.opendm_source, OPEN_DM)
    manifest = policy_manifest("fast-vla-robotwin-policy", {"fastvla": FAST_VLA, "opendm": OPEN_DM},
                               DOCKERFILE, HERE / "serve_fast_vla.py")
    if args.build_tag:
        with tempfile.TemporaryDirectory(prefix="orbit-fast-vla-opendm-") as temporary:
            context = Path(temporary) / "opendm"
            export_source(args.opendm_source, OPEN_DM, context, ("opendm", "pyproject.toml", "README.md", "LICENSE"))
            build_policy_image(args, "fastvla", FAST_VLA, DOCKERFILE, manifest, source_paths=("fastvla",),
                               extra_contexts=(("opendm", context),))
        return
    image = require_image(args.policy_image, manifest)
    reference = json.loads(args.reference_file.read_text())
    profile = policy_profile(reference)
    required = ("actor/config.json", "actor/model.safetensors", "actor/norm_stats.json", "actor/rope_tables.pt",
                "dm05/config.json", "dm05/model.safetensors", "dm05/tokenizer.json", "dm05/tokenizer_config.json",
                "dm05/processor_config.json", "dm05/chat_template.jinja", DINO / "refs/main", DINO_CONFIG)
    if not all((args.weights / path).is_file() for path in required):
        raise ValueError("Fast-VLA actor, DM0.5 checkpoint, or DINOv2 configuration is incomplete")
    actor = json.loads((args.weights / "actor/config.json").read_text())
    if (actor["vlm"] != "Dexmal/DM05-robotwin2" or actor["vlm_revision"] != DM05_REVISION
            or actor["backbone"] != "facebook/dinov2-base"
            or file_digest(args.weights / DINO_CONFIG) != DINO_DIGEST
            or (args.weights / DINO / "refs/main").read_text().strip() != DINO_REVISION):
        raise ValueError("Fast-VLA backbone configuration differs from the released recipe")
    checkpoint = tree_digest(args.weights / "actor")
    normalization = file_digest(args.weights / "actor/norm_stats.json")
    backbone = digest({"dm05": tree_digest(args.weights / "dm05"), "vision": tree_digest(args.weights / "hub")})
    name = "fast-vla-robotwin"
    registration = {
        "name": name, "version": "1", "connector": "policy-ws", "replanSteps": 50,
        "profile": profile,
        "checkpointDigest": checkpoint, "normalizationDigest": normalization, "backboneDigest": backbone,
        "randomness": {"backend": "stateless", "scope": "stateless"},
        "weights": {"dataset": name, "target": "/weights"},
        "service": {
            "name": "policy", "image": image, "gpusOf": "main", "gpus": 0, "gpuMemGB": 24,
            "memGB": 24, "cpus": 4,
            "command": ["--weights", "/weights", "--checkpoint-digest", checkpoint,
                        "--normalization-digest", normalization, "--backbone-digest", backbone],
            "healthcheck": {"command": ["python", "-c",
                                        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5).read()"],
                            "intervalSec": 10, "timeoutSec": 6, "startPeriodSec": 300, "retries": 90},
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(registration, indent=2) + "\n")


if __name__ == "__main__":
    main()
