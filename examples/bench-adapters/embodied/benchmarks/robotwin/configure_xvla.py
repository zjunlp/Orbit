"""Generate a RoboTwin Cartesian benchmark and the X-VLA policy registration."""

import argparse
import json
from pathlib import Path
import subprocess
import sys

EMBODIED = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(EMBODIED), str(EMBODIED / "policies/x-vla")]

from adapter import HERE, digest, file_digest
from native_runtime import image_id
from configure_robotwin import configure_benchmark
from orbit_embodied.assets import tree_digest
from serve_xvla import CHUNK_SIZE, normalization_digest


XVLA_REVISION = "6c4ecfb8be458ae7c0c96094e4b0add4174f4fe2"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--robotwin-source", type=Path, required=True)
    parser.add_argument("--xvla-source", type=Path, required=True)
    parser.add_argument("--suite", choices=("demo_clean", "demo_randomized"), default="demo_clean")
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--benchmark-image", required=True)
    parser.add_argument("--policy-image", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    files = ("evaluation/robotwin-2.0/client.py", "evaluation/robotwin-2.0/eval_robotwin.sh", "deploy.py")
    source = ["git", "-C", str(args.xvla_source)]
    if subprocess.check_output(source + ["rev-parse", "HEAD"], text=True).strip() != XVLA_REVISION:
        raise ValueError("expected the pinned X-VLA reference checkout")
    subprocess.run(source + ["diff", "--quiet", "HEAD", "--", *files], check=True)
    suite = args.suite.replace("_", "-")
    reference = json.loads((HERE / "profiles/robotwin-demo-clean.json").read_text())
    benchmark = configure_benchmark(args, reference)
    environment = reference["environment"]
    environment.update(controller="ee", instructionMode="task-name", nativeHorizons=environment["horizons"],
                       horizons={task: min(limit, CHUNK_SIZE * 10) for task, limit in environment["horizons"].items()})
    order = [arm + "_" + channel for arm in ("left", "right")
             for channel in ("x", "y", "z", "qw", "qx", "qy", "qz", "gripper")]
    profile = reference["benchmarkProfile"]
    profile["id"] = "robotwin-aloha-agilex-cartesian/1"
    profile["observations"]["ee_state"] = {
        "semantic": "commanded-aloha-ee-pose-and-live-gripper",
        "shape": [16], "dtype": "float64", "frame": "robotwin-world",
        "unit": "metres-and-quaternion-and-gripper-fraction", "order": order,
    }
    profile["action"] = {
        "semantic": "absolute-aloha-ee-pose-and-gripper-target",
        "shape": [16], "controller": "robotwin-ee-curobo", "frame": "robotwin-world",
        "unit": "metres-and-quaternion-and-signed-gripper", "rotation": "native-quaternion-wxyz",
        "gripper": "xvla-binary-robotwin", "order": order,
    }
    observations = {name: field for name, field in profile["observations"].items() if name != "joint_state"}
    reference["policyProfile"] = {**profile, "id": "xvla-robotwin-input/1", "observations": observations}
    reference["observationMap"] = {name: name for name in observations}
    reference["id"] = f"robotwin-2.0-{suite}-cartesian/2"
    reference["parameters"]["replanSteps"] = CHUNK_SIZE
    scenario = "Clean" if args.suite == "demo_clean" else "Randomized"
    reference["randomness"] = {
        "referenceEnvironment": f"Native RoboTwin {scenario} with frozen expert-accepted seeds and task-name instructions.",
        "referencePolicy": "X-VLA domain 6 with Torch seed 0 per service.",
        "comparison": "The released client executes up to ten 30-action chunks.",
    }
    reference["reference"]["policyRecipe"] = {
        "repository": "https://github.com/2toinf/X-VLA", "commit": XVLA_REVISION,
        "files": {name: file_digest(args.xvla_source / name) for name in files},
    }
    benchmark["name"] = f"robotwin-{suite}-cartesian-native"
    benchmark["config"].update(reference=json.dumps(reference), profileDigest=digest(reference))
    checkpoint, normalization = tree_digest(args.weights), normalization_digest(args.weights)
    name = "xvla-robotwin2"
    policy = {"name": name, "version": "1", "connector": "policy-ws",
              "replanSteps": CHUNK_SIZE, "profile": reference["policyProfile"], "checkpointDigest": checkpoint,
              "normalizationDigest": normalization, "randomness": {"backend": "torch", "initialSeed": 0, "scope": "service"},
              "weights": {"dataset": name, "target": "/weights"}, "service": {
                  "name": "policy", "image": image_id(args.policy_image), "gpusOf": "main", "gpus": 0,
                  "gpuMemGB": 12, "memGB": 16, "cpus": 4,
                  "command": ["--checkpoint", "/weights", "--checkpoint-digest", checkpoint,
                              "--normalization-digest", normalization],
                  "healthcheck": {"command": ["/opt/xvla/bin/python", "/opt/orbit/serve_xvla.py", "--healthcheck"],
                                  "intervalSec": 5, "timeoutSec": 5, "startPeriodSec": 180, "retries": 60},
              }}
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name, value in (("benchmark", benchmark), ("policy", policy), ("reference", reference)):
        (args.output_dir / (name + ".json")).write_text(json.dumps(value, indent=2) + "\n")


if __name__ == "__main__":
    main()
