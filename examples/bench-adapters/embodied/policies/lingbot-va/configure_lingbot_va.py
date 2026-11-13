"""Build or register the pinned LingBot-VA policy and native RoboTwin Clean recipe."""

import argparse
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
EMBODIED = HERE.parents[1]
sys.path[:0] = [str(EMBODIED), str(EMBODIED / "benchmarks/robotwin")]

from adapter import digest, file_digest
from configure_robotwin import configure_benchmark
from native_runtime import build_policy_image, check_policy_source, policy_manifest, require_image
from orbit_embodied.robotwin import RoboTwinLingBotBenchmark
from serve_lingbot_va import REPLAN, checkpoint_digest


SOURCE = {"repository": "https://github.com/robbyant/lingbot-va",
          "commit": "7c6ffa9bfc4b83582cafc860fab4c82cc7deeeeb"}
DOCKERFILE = HERE / "policy.Dockerfile"
NORMALIZATION = "wan_va/configs/va_robotwin_cfg.py"
NAME = "lingbot-va-robotwin"
BENCHMARK = "robotwin-demo-clean-lingbot-va-native"


def reference_for_policy(reference):
    benchmark = RoboTwinLingBotBenchmark
    order = [f"{arm}_{channel}" for arm in ("left", "right")
             for channel in ("x", "y", "z", "qw", "qx", "qy", "qz", "gripper")]
    profile = reference["benchmarkProfile"]
    profile["id"] = "robotwin-aloha-agilex-lingbot-va/1"
    observations = {name: profile["observations"][name] for name in ("instruction", "joint_state")}
    frames = benchmark.chunk_controls // benchmark.frame_stride
    for camera in benchmark.camera_names:
        raw = profile["observations"][camera]
        observations[camera + "_history"] = {**raw, "shape": [frames, *raw["shape"]],
                                             "layout": "THWC", "format": "RGB-keyframes-every-4-controls"}
    observations["initial_ee_pose"] = {
        "semantic": "initial-aloha-ee-pose-and-gripper", "dtype": "float64", "shape": [16],
        "frame": "robotwin-world", "format": "native-quaternion-wxyz",
        "unit": "metres-and-quaternion-and-gripper-fraction", "order": order,
    }
    profile.update(observations=observations, action={
        "semantic": "absolute-aloha-ee-pose-and-gripper-target", "shape": [16],
        "controller": "robotwin-ee-curobo", "frame": "robotwin-world",
        "unit": "metres-and-quaternion-and-gripper-fraction",
        "rotation": "native-quaternion-wxyz", "gripper": "normalized-open-fraction", "order": order,
    })
    policy_observations = {key: value for key, value in observations.items() if key != "joint_state"}
    reference["policyProfile"] = {**profile, "id": "lingbot-va-robotwin-input/1", "observations": policy_observations}
    reference["observationMap"] = {name: name for name in policy_observations}
    reference["environment"].update(controller="lingbot-va-ee", instructionSplit="seen")
    reference["environment"]["reset"] = "environmentSeed+initialStateId; native expert precheck; frozen seen instructions"
    reference["parameters"].update(firstReplanSteps=benchmark.initial_controls, replanSteps=REPLAN)
    reference["id"] = "robotwin-2.0-demo-clean-lingbot-va/1"
    reference["reference"]["policyRecipe"] = SOURCE
    reference["randomness"] = {
        "referenceEnvironment": "Native Clean with expert-accepted scene seeds and frozen seen instructions.",
        "referencePolicy": "Torch seed 0 per service; reset inference caches per episode.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--build-tag")
    operation.add_argument("--policy-image")
    parser.add_argument("--policy-base")
    parser.add_argument("--robotwin-source", type=Path)
    parser.add_argument("--assets", type=Path)
    parser.add_argument("--benchmark-image")
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    check_policy_source(args.source, SOURCE)
    manifest = policy_manifest("lingbot-va-robotwin-policy", {"lingbotva": SOURCE}, DOCKERFILE, HERE / "serve_lingbot_va.py")
    if args.build_tag:
        if not args.policy_base:
            parser.error("--build-tag requires --policy-base")
        build_policy_image(args, "lingbotva", SOURCE, DOCKERFILE, manifest, source_paths=("wan_va",))
        return
    if not all((args.robotwin_source, args.assets, args.benchmark_image, args.weights, args.output_dir)):
        parser.error("--policy-image requires --robotwin-source, --assets, --benchmark-image, --weights and --output-dir")
    image = require_image(args.policy_image, manifest)
    args.suite, args.recipe = "demo_clean", "joint"
    reference = json.loads((EMBODIED / "profiles/robotwin-demo-clean.json").read_text())
    registration = configure_benchmark(args, reference)
    reference_for_policy(reference)
    registration["name"] = BENCHMARK
    registration["config"].update(reference=json.dumps(reference), profileDigest=digest(reference))
    checkpoint = checkpoint_digest(args.weights)
    normalization = file_digest(args.source / NORMALIZATION)
    policy = {
        "name": NAME, "version": "1", "connector": "policy-ws", "replanSteps": REPLAN, "callTimeoutSec": 300,
        "profile": reference["policyProfile"], "checkpointDigest": checkpoint, "normalizationDigest": normalization,
        "randomness": {"backend": "torch", "initialSeed": 0, "scope": "service"},
        "weights": {"dataset": NAME, "target": "/weights"},
        "service": {"name": "policy", "image": image, "gpusOf": "main", "gpus": 0,
                    "gpuMemGB": 27, "memGB": 36, "cpus": 8,
                    "command": ["--weights", "/weights", "--checkpoint-digest", checkpoint,
                                "--normalization-digest", normalization, "--cpu-threads", "8"],
                    "healthcheck": {"command": ["python", "-c",
                        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5).read()"],
                        "intervalSec": 10, "timeoutSec": 6, "startPeriodSec": 300, "retries": 90}},
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for filename, value in (("benchmark", registration), ("policy", policy), ("reference", reference)):
        (args.output_dir / (filename + ".json")).write_text(json.dumps(value, indent=2) + "\n")


if __name__ == "__main__":
    main()
