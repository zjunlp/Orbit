"""Build frozen registrations for the native RLinf ManiSkill3 and Meta-World recipes."""

import argparse
import json
from pathlib import Path
import subprocess

from adapter import HERE, digest, file_digest, implementation_digest
from configure_groot import image_id
from orbit_embodied.assets import tree_digest
from serve_metaworld import NORMALIZATION_DIR


RLINF_REVISION = "1bf78980d9339cbc67497eddceb9a1e3a74e2acc"
MANISKILL_TASK = "PutOnPlateInScene25Main-v3"
MANISKILL_SOURCE = "rlinf/envs/sim/maniskill/tasks/put_on_in_scene_multi.py"
METAWORLD_CONFIG = "rlinf/envs/sim/metaworld/metaworld_config.json"


def reference_for(model, source, assets):
    if model == "maniskill3":
        files = [MANISKILL_SOURCE, "examples/embodiment/config/maniskill_grpo_openvlaoft.yaml",
                 "examples/embodiment/config/env/maniskill_put_on_plate_in_scene_25_main.yaml",
                 "rlinf/envs/sim/maniskill/maniskill_env.py"]
        environment = {"kind": model, "tasks": [MANISKILL_TASK], "horizon": 80, "controlHz": 5,
                       "assets": {"dataset": "maniskill3-plate-assets", "target": "/maniskill-data",
                                  "digest": tree_digest(assets)}}
        height, width, replan, settle, camera = 480, 640, 8, 0, "3rd_view_camera"
        action = {"semantic": "widowx-ee-target-delta", "shape": [7],
                  "controller": "arm_pd_ee_target_delta_pose_align2_gripper_pd_joint_pos",
                  "frame": "robot-base", "unit": "controller-normalized", "rotation": "axis-angle",
                  "gripper": "widowx-minus1-close-plus1-open"}
    else:
        files = [METAWORLD_CONFIG, "toolkits/standalone_eval_scripts/openpi/metaworld_eval.py",
                 "rlinf/models/embodiment/openpi/policies/metaworld_policy.py"]
        instructions = json.loads((source / METAWORLD_CONFIG).read_text())["TASK_DESCRIPTIONS"]
        if len(instructions) != 50:
            raise ValueError("Meta-World MT50 requires 50 pinned task instructions")
        environment = {"kind": model, "tasks": list(instructions), "instructions": instructions,
                       "horizon": 160, "controlHz": 25}
        height, width, replan, settle, camera = 480, 480, 5, 15, "camera-2"
        action = {"semantic": "sawyer-ee-delta", "shape": [4], "controller": "metaworld-sawyer-xyz",
                  "frame": "world", "unit": "controller-normalized", "rotation": "fixed",
                  "gripper": "metaworld-signed-gripper"}
    subprocess.run(["git", "-C", str(source), "diff", "--quiet", "HEAD", "--", *files], check=True)
    fields = {"front_rgb": {"semantic": "rgb", "camera": camera, "dtype": "uint8", "layout": "HWC",
                           "shape": [height, width, 3]},
              "instruction": {"semantic": "language-instruction", "dtype": "string", "shape": []}}
    if model == "metaworld":
        fields["state"] = {"semantic": "sawyer-ee-position-gripper", "dtype": "float32", "shape": [4],
                           "frame": "world", "unit": "metre-and-normalized-gripper",
                           "order": ["x", "y", "z", "gripper"]}
    native = {"id": model + "-native/1", "observations": fields, "action": action}
    return {
        "id": "maniskill3-rlinf-reference/1" if model == "maniskill3" else "metaworld-rlinf-reference/2",
        "environment": environment,
        "parameters": {"replanSteps": replan, "settleSteps": settle, "successRule": "last"},
        "benchmarkProfile": native,
        "policyProfile": {**native, "id": model + "-rlinf-input/1"},
        "observationMap": {name: name for name in fields},
        "reference": {"evaluation": {"repository": "https://github.com/RLinf/RLinf", "commit": RLINF_REVISION},
                      "files": {name: file_digest(source / name) for name in files}},
        "randomness": {"referenceEnvironment": "Native task with frozen environment reset seeds.",
                       "referencePolicy": "Published RLinf checkpoint with Torch seed 0 per service.",
                       "comparison": "Orbit records the first native success in each frozen episode."},
        "scoreName": "ManiSkill3 plate-25 success" if model == "maniskill3" else "Meta-World MT50 success",
    }


def policy_for(model, reference, weights, image):
    mani = model == "maniskill3"
    checkpoint = tree_digest(weights)
    norm = file_digest(weights / ("config.json" if mani else NORMALIZATION_DIR + "/norm_stats.json"))
    command = ["--checkpoint", "/weights", "--checkpoint-digest", checkpoint, "--normalization-digest", norm]
    healthcheck = ["/.venv/bin/python", "/opt/orbit/serve_metaworld.py", "--healthcheck"]
    if mani:
        command = ["/opt/orbit/serve_openvla.py", *command, "--decoding", "rlinf-maniskill", "--unnorm-key", "bridge_orig"]
        healthcheck = ["python", "/opt/orbit/serve_openvla.py", "--healthcheck"]
    name = "openvla-oft-rlinf-maniskill3" if mani else "pi05-rlinf-metaworld"
    return {"name": name, "version": "1", "connector": "policy-ws",
              "replanSteps": reference["parameters"]["replanSteps"], "profile": reference["policyProfile"],
              "checkpointDigest": checkpoint, "normalizationDigest": norm,
              "randomness": {"backend": "torch", "initialSeed": 0, "scope": "service"},
              "weights": {"dataset": name, "target": "/weights"}, "service": {
                  "name": "policy", "image": image_id(image), "gpusOf": "main", "gpus": 0,
                  "gpuMemGB": 24, "memGB": 32, "cpus": 4, "command": command,
                  "healthcheck": {"command": healthcheck, "intervalSec": 5, "timeoutSec": 5,
                                  "startPeriodSec": 300, "retries": 90},
              }}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=("maniskill3", "metaworld"), required=True)
    parser.add_argument("--reference-source", type=Path, required=True)
    parser.add_argument("--benchmark-only", action="store_true")
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--assets", type=Path)
    parser.add_argument("--policy-image")
    parser.add_argument("--benchmark-image", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    mani = args.model == "maniskill3"
    if mani and not args.assets:
        parser.error("ManiSkill3 requires the native simulator assets")
    if not args.benchmark_only and not (args.weights and args.policy_image):
        parser.error("policy registration requires --weights and --policy-image")
    root = args.reference_source.resolve()
    if subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip() != RLINF_REVISION:
        raise ValueError("expected the pinned RLinf reference checkout")
    reference = reference_for(args.model, root, args.assets)
    benchmark = {"name": "maniskill3-plate25-native" if mani else "metaworld-mt50-native",
                 "path": str(root), "adapter": str(HERE / "adapter.py"), "config": {
                     "image": image_id(args.benchmark_image), "python": "/usr/local/bin/python",
                     "reference": json.dumps(reference),
                     "profileDigest": digest(reference), "implementationDigest": implementation_digest(),
                     "simGpus": "1", "simGpuMemGB": "8" if mani else "4",
                     "renderer": "vulkan" if mani else "egl",
                 }}
    args.output_dir.mkdir(parents=True, exist_ok=True)
    outputs = {"benchmark": benchmark, "reference": reference}
    if not args.benchmark_only:
        outputs["policy"] = policy_for(args.model, reference, args.weights, args.policy_image)
    for name, value in outputs.items():
        (args.output_dir / (name + ".json")).write_text(json.dumps(value, indent=2) + "\n")


if __name__ == "__main__":
    main()
