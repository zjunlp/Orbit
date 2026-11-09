"""Generate benchmark-only registrations for pinned ManiSkill3 tabletop tasks."""

import argparse
import json
from pathlib import Path

from adapter import HERE, digest, file_digest, implementation_digest
from configure_groot import image_id
from orbit_embodied.assets import tree_digest


VERSION = "3.0.0b22"
CATALOG = HERE / "profiles/maniskill3-tabletop.json"


def reference_for(scope, profile, assets):
    robot = profile["robot"]
    dimensions = profile["actionSize"]
    tasks = profile["tasks"]
    name = "maniskill3-tabletop-" + scope
    environment = {
        "kind": "maniskill3-tabletop", "version": VERSION, "robot": robot, "controlHz": 20,
        "tasks": list(tasks), "horizons": {task: row[0] for task, row in tasks.items()},
        "instructions": {task: row[1] for task, row in tasks.items()},
    }
    if assets:
        environment["assetSource"] = profile["assetSource"]
        environment["assets"] = {"dataset": name + "-assets", "target": "/maniskill-data",
                                 "digest": tree_digest(assets)}
    camera = {"semantic": "rgb", "dtype": "uint8", "layout": "HWC", "shape": [128, 128, 3]}
    observations = {"front_rgb": {**camera, "camera": "base_camera"},
                    "instruction": {"semantic": "language-instruction", "dtype": "string", "shape": []}}
    if profile.get("wristCamera"):
        observations["wrist_rgb"] = {**camera, "camera": "hand_camera"}
    goal_source = profile.get("goalPosition")
    observation_suffix = ""
    if goal_source:
        environment["goalPosition"] = goal_source
        observations["goal_pos"] = {"semantic": "task-goal-position", "dtype": "float32",
                                    "shape": [3], "frame": "world", "unit": "metre",
                                    "order": ["x", "y", "z"]}
        observation_suffix = "-goal"
    native = {
        "id": f"maniskill3-{profile['layout']}-joint-delta{observation_suffix}/1",
        "observations": observations,
        "action": {
            "semantic": "maniskill3-" + profile["layout"] + "-joint-delta",
            "shape": [dimensions], "controller": "pd_joint_delta_pos",
            "frame": "robot-joints", "unit": "controller-normalized", "rotation": "joint-space",
            "gripper": "none" if robot == "panda_stick" else "native-normalized-gripper-position",
        },
    }
    return {
        "id": name + "/2", "environment": environment,
        "benchmarkProfile": native, "observationMap": {field: field for field in observations},
        "parameters": {"replanSteps": 1, "settleSteps": 0, "successRule": "last"},
        "reference": {"evaluation": {"repository": "https://github.com/mani-skill/ManiSkill", "commit": VERSION},
                      "files": {CATALOG.relative_to(HERE).as_posix(): file_digest(CATALOG)}},
        "scoreName": "ManiSkill3 tabletop " + scope + " success", "scoreUnit": "task",
    }


def main():
    profiles = json.loads(CATALOG.read_text())
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", choices=profiles, required=True)
    parser.add_argument("--assets", type=Path)
    parser.add_argument("--benchmark-image", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    profile = profiles[args.profile]
    required_asset = profile.get("assetDirectory")
    if required_asset:
        if not args.assets or not any(path.is_file() for path in (args.assets / required_asset).rglob("*")):
            parser.error("this profile needs --assets with " + required_asset)
    elif args.assets:
        parser.error("this profile uses assets packaged in the simulator image")
    reference = reference_for(args.profile, profile, args.assets)
    benchmark = {
        "name": "maniskill3-tabletop-" + args.profile + "-native",
        "path": str(HERE), "adapter": str(HERE / "adapter.py"),
        "config": {"image": image_id(args.benchmark_image), "python": "/usr/local/bin/python",
                   "reference": json.dumps(reference), "profileDigest": digest(reference),
                   "implementationDigest": implementation_digest(),
                   "simGpus": "1", "simGpuMemGB": "4", "renderer": "vulkan"},
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name, value in (("benchmark", benchmark), ("reference", reference)):
        (args.output_dir / (name + ".json")).write_text(json.dumps(value, indent=2) + "\n")


if __name__ == "__main__":
    main()
