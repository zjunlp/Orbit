"""Build and register the original RGB SPOC and FLaRe checkpoints."""

import argparse
import json
from pathlib import Path
import re
import sys
import tempfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))

from adapter import digest
from native_runtime import build_policy_image, check_policy_source, export_source, image_id, policy_manifest, require_image
from orbit_embodied.assets import tree_digest
from orbit_embodied.chores import TASKS, semantic_profile
from serve_chores import RANDOMNESS, RELEASE, asset_identity

SOURCES = {
    "spoc": {"repository": "https://github.com/allenai/spoc-robot-training",
             "commit": "baaa237ad162e31cafb0d920a18c31093a095065"},
    "flare": {"repository": "https://github.com/JiahengHu/FLaRe",
              "commit": "656f46ab332b09490d30bc62b9fb58b7b4ecfd0d"},
}
CLIP = {"repository": "https://github.com/openai/CLIP",
        "commit": "a1d071733d7111c9c014f024669f959182114e33"}
ALLENACT = {"repository": "https://github.com/allenai/allenact",
            "commit": "d055fc9d4533f086e0340fe0a838ed42c28d932e"}
DOCKERFILE = HERE / "policy.Dockerfile"
SERVER = HERE / "serve_chores.py"
SOURCE_PATHS = ("LICENSE", "architecture", "environment", "online_evaluation", "tasks", "training",
                "utils", "spoc_constants.py")
CHORES_PROFILES = ("chores-small/1", "chores-large/1")
SPOC_PROFILES = dict(zip(("spoc-chores-small", "spoc-chores-large"), CHORES_PROFILES))
FLARE_TASK_TYPES = {
    "flare-chores-objectnav": [task for task in TASKS if task.startswith("ObjectNav")],
    "flare-chores-pickup": ["PickupType"],
    "flare-chores-fetch": ["FetchType"],
    "flare-chores-roomvisit": ["SimpleExploreHouse"],
}


def check_backbones(root, family):
    hub = root / "huggingface/hub"
    if family == "spoc":
        snapshots = {
            "models--timm--ViT-B-16-SigLIP-256": ("open_clip_config.json", "open_clip_model.safetensors"),
            "models--timm--ViT-B-16-SigLIP": ("tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"),
        }
    else:
        snapshots = {"models--t5-small": ("config.json", "model.safetensors", "spiece.model")}
        for path in ("dinov2/hubconf.py", "dinov2_vits14_pretrain.pth"):
            if not (root / path).is_file():
                raise ValueError("missing FLaRe backbone file: " + path)
    for name, required in snapshots.items():
        model = hub / name
        revision = (model / "refs" / "main").read_text()
        if not re.fullmatch("[0-9a-f]{40}", revision):
            raise ValueError("expected the original Hugging Face cache ref for " + name)
        snapshot = model / "snapshots" / revision
        for path in required:
            if not (snapshot / path).is_file():
                raise ValueError(f"missing CHORES backbone snapshot file: {name}/{path}")
    return tree_digest(root)


def definition(name, image, identity, backbone):
    profile = semantic_profile()
    del profile["observations"]["navigation_pose"]
    profile["id"] = name + "/1"
    scope = ({"profiles": [SPOC_PROFILES[name]]} if name in SPOC_PROFILES else
             {"profiles": list(CHORES_PROFILES), "taskTypes": FLARE_TASK_TYPES[name]})
    return {
        "name": name, "version": "1", "connector": "policy-ws", "replanSteps": 1,
        "callTimeoutSec": 60, "randomness": RANDOMNESS, "profile": profile, "recommendedScope": scope,
        "backboneDigest": backbone, **identity,
        "weights": {"dataset": name, "target": "/weights"},
        "service": {"name": "policy", "image": image, "gpusOf": "main", "memGB": 12, "cpus": 2,
                    "command": ["--model", name, "--weights", "/weights", "--backbone-digest", backbone,
                                "--checkpoint-digest", identity["checkpointDigest"],
                                "--normalization-digest", identity["normalizationDigest"]],
                    "healthcheck": {"command": ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5).close()"],
                                    "intervalSec": 5, "timeoutSec": 6, "startPeriodSec": 120, "retries": 40}},
    }


def main():
    releases = json.loads(RELEASE.read_text())
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--family", choices=tuple(SOURCES), required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--policy-base", required=True)
    parser.add_argument("--allenact-source", type=Path)
    parser.add_argument("--clip-source", type=Path)
    parser.add_argument("--backbones", type=Path, required=True)
    parser.add_argument("--model", choices=tuple(releases))
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--output-dir", type=Path)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--build-tag")
    operation.add_argument("--policy-image")
    args = parser.parse_args()
    source = SOURCES[args.family]
    check_policy_source(args.source, source)
    backbone = check_backbones(args.backbones, args.family)
    sources = {args.family: source, "clip": CLIP}
    if args.family == "flare":
        sources["allenact"] = ALLENACT
    manifest = policy_manifest(args.family + "-chores", sources, DOCKERFILE, SERVER)
    manifest.update(base=image_id(args.policy_base), backbone=backbone, release=digest(releases))
    if args.build_tag:
        with tempfile.TemporaryDirectory(prefix="orbit-chores-policy-deps-") as directory:
            if args.clip_source is None:
                parser.error("building a CHORES policy requires --clip-source")
            clip = Path(directory) / "clip"
            export_source(args.clip_source, CLIP, clip, ("setup.py", "MANIFEST.in", "clip", "requirements.txt"))
            context = Path(directory) / "allenact"
            if args.family == "flare":
                if args.allenact_source is None:
                    parser.error("building FLaRe requires --allenact-source")
                export_source(args.allenact_source, ALLENACT, context,
                              (".VERSION", "dev_requirements.txt", "allenact", "allenact_plugins"))
            else:
                context.mkdir()
            build_policy_image(args, "policy_source", source, DOCKERFILE, manifest, source_paths=SOURCE_PATHS,
                               extra_contexts=(("backbones", args.backbones), ("allenact", context), ("clip", clip)),
                               build_args=("POLICY_FAMILY=" + args.family,))
        return
    if not args.model or not args.weights or not args.output_dir or not args.model.startswith(args.family + "-"):
        parser.error("--policy-image requires a matching --model, --weights and --output-dir")
    image = require_image(args.policy_image, manifest)
    identity = asset_identity(args.weights, releases[args.model])
    policy = definition(args.model, image, identity, backbone)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / (args.model + ".json")).write_text(json.dumps(policy, indent=2) + "\n")


if __name__ == "__main__":
    main()
