"""Build Fast-WAM or register its policies and native LIBERO recipes."""

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import HERE as EMBODIED, check_source, file_digest
from native_runtime import build_policy_image, check_policy_source, image_id, policy_manifest, require_image, write_benchmark
from orbit_embodied.libero_suites import LABELS, SUITES
from serve_fast_wam import CHECKPOINT, MODES, REPLAN, SEED, STATS, backbone_digest


SOURCE = {"repository": "https://github.com/yuantianyuan01/FastWAM",
          "commit": "7faa71108368fbb3b6885649f112af607427a2d4"}
HERE = Path(__file__).resolve().parent
DOCKERFILE = HERE / "policy.Dockerfile"
HORIZONS = {"libero_spatial": 400, "libero_object": 400, "libero_goal": 400, "libero_10": 700}
RELEASE = "sha256:26b4efffded221b9a303ca8f2cddb9999c8b7524e2751c855c74a986242ce8b4"
NORMALIZATION = "sha256:30f81ad7d5076e97323e3328bce003e01a04cb21327b5bacd21bb72846768638"


def benchmark_reference(suite):
    reference = json.loads((EMBODIED / "profiles/openvla-libero.json").read_text())
    reference["reference"].pop("evaluation")
    reference["reference"]["policyRecipe"] = SOURCE
    label = LABELS[suite]
    reference.update(id=f"libero-{label}-fast-wam/1", scoreName=f"LIBERO {label.title()} success (Fast-WAM recipe)",
                     horizons={suite: HORIZONS[suite]})
    reference["environment"] = {"kind": "libero", "protocol": "fast-wam", "environmentSeed": SEED}
    reference["policyProfile"]["id"] = "fast-wam-libero-input/1"
    reference["parameters"].update(replanSteps=REPLAN, settleSteps=30, environmentSeed=SEED)
    reference["randomness"] = {
        "referenceEnvironment": f"LIBERO {label.title()} with seed 42 and 30 native settle controls",
        "referencePolicy": "Fast-WAM initializes a new CPU generator from seed 42 for each prediction",
    }
    reference.pop("status")
    return reference


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--build-tag")
    operation.add_argument("--policy-image")
    parser.add_argument("--policy-base")
    parser.add_argument("--openpi-source", type=Path)
    parser.add_argument("--benchmark-image")
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--suite", choices=SUITES, default="libero_spatial")
    args = parser.parse_args()
    check_policy_source(args.source, SOURCE)
    manifest = policy_manifest("fast-wam-libero-policy", {"fastwam": SOURCE}, DOCKERFILE, HERE / "serve_fast_wam.py")
    if args.build_tag:
        if not args.policy_base:
            parser.error("--build-tag requires --policy-base")
        build_policy_image(args, "fastwam", SOURCE, DOCKERFILE, manifest, source_paths=("src", "configs"))
        return
    if not all((args.openpi_source, args.benchmark_image, args.weights, args.output_dir)):
        parser.error("--policy-image requires --openpi-source, --benchmark-image, --weights and --output-dir")
    image = require_image(args.policy_image, manifest)
    reference = benchmark_reference(args.suite)
    check_source(args.openpi_source, reference["reference"]["openpi"], reference["reference"]["files"])
    checkpoint = file_digest(args.weights / "policy" / CHECKPOINT)
    normalization = file_digest(args.weights / "policy" / STATS)
    if checkpoint != RELEASE or normalization != NORMALIZATION:
        raise ValueError("Fast-WAM requires the released optional-IDM checkpoint and normalization")
    backbone = backbone_digest(args.weights / "backbone")
    benchmark = f"libero-{LABELS[args.suite]}-fast-wam-native"
    write_benchmark(args.output_dir, benchmark, args.openpi_source, image_id(args.benchmark_image),
                    "egl", "/opt/fast-wam-libero/bin/python", reference, gpu_mem=4, suite=args.suite)
    for mode in MODES:
        policy = {
            "name": "fast-wam-libero-" + mode.replace("_", "-"), "version": "1", "connector": "policy-ws",
            "replanSteps": REPLAN, "callTimeoutSec": 300, "profile": reference["policyProfile"],
            "checkpointDigest": checkpoint, "normalizationDigest": normalization, "backboneDigest": backbone,
            "randomness": {"backend": "stateless", "scope": "stateless"},
            "weights": {"dataset": "fast-wam-libero", "target": "/weights"},
            "service": {"name": "policy", "image": image, "gpusOf": "main", "gpus": 0,
                        "gpuMemGB": 33, "memGB": 40, "cpus": 4,
                        "command": ["--weights", "/weights", "--mode", mode, "--checkpoint-digest", checkpoint,
                                    "--normalization-digest", normalization, "--backbone-digest", backbone],
                        "healthcheck": {"command": ["python", "-c",
                            "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5).read()"],
                            "intervalSec": 10, "timeoutSec": 6, "startPeriodSec": 300, "retries": 90}},
        }
        (args.output_dir / benchmark / ("policy-" + mode + ".json")).write_text(json.dumps(policy, indent=2) + "\n")


if __name__ == "__main__":
    main()
