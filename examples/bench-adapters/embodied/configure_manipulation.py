"""Build pinned runtimes and register RoboMimic PH."""

import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from adapter import HERE, check_source, digest, file_digest, implementation_digest
from native_runtime import MANIFEST_LABEL, export_source, require_image


ROBOMIMIC = {"repository": "https://github.com/ARISE-Initiative/robomimic",
             "commit": "d309eaecc18acf4152a830a895a6984b8ac71b05"}
ROBOSUITE = {"repository": "https://github.com/ARISE-Initiative/robosuite",
             "commit": "51cc01785bab80ffeed20da15e67d7dd4140e76a"}
PH_TASKS = ("lift", "can", "square", "transport", "tool_hang")
ROBOMIMIC_CAMERAS = {
    "transport": ("shouldercamera0", "robot0_eye_in_hand", "shouldercamera1", "robot1_eye_in_hand"),
    "tool_hang": ("sideview", "robot0_eye_in_hand"),
}
PH_ENVS = dict(zip(PH_TASKS, ("Lift", "PickPlaceCan", "NutAssemblySquare", "TwoArmTransport", "ToolHang")))


def build(args, sources, record):
    with tempfile.TemporaryDirectory(prefix="orbit-manipulation-") as temporary:
        contexts = []
        for name, (root, source, paths) in sources.items():
            export_source(root, source, Path(temporary) / name, paths)
            contexts.extend(["--build-context", name + "=" + str(Path(temporary) / name)])
        label = MANIFEST_LABEL + "=" + json.dumps(record, sort_keys=True, separators=(",", ":"))
        subprocess.run(["docker", "build", "--label", "orbit.task=embodied-eval", "--label", label,
                        *contexts,
                        "-f", str(HERE / (args.kind + ".Dockerfile")), "-t", args.build_tag, str(HERE.parents[2])],
                       check=True)


def rgb(camera, shape, layout):
    return {"semantic": "rgb", "dtype": "uint8", "shape": shape, "camera": camera, "layout": layout}


def robomimic_reference(task, dataset, observation, horizon):
    import h5py

    with h5py.File(dataset, "r") as handle:
        data = handle["data"]
        metadata = json.loads(data.attrs["env_args"])
        demo = data["demo_0"]
        if metadata["env_name"] != PH_ENVS[task] or metadata["env_version"] != "1.5.1" or metadata["type"] != 1:
            raise ValueError("expected the official RoboMimic PH v1.5.1 environment for " + task)
        kwargs = metadata["env_kwargs"]
        arms = 2 if task == "transport" else 1
        if kwargs["robots"] != ["Panda"] * arms or demo["actions"].shape[1] != 7 * arms:
            raise ValueError("unexpected native action layout for " + task)
        controller = kwargs["controller_configs"]["body_parts"]["right"]
        if (controller["type"] != "OSC_POSE" or controller.get("input_type", "delta") != "delta"
                or not controller.get("control_delta", True) or controller["input_ref_frame"] != "world"
                or kwargs["control_freq"] != 20):
            raise ValueError("unexpected RoboMimic controller semantics")
        fields = {}
        for arm in range(arms):
            for key, semantic, extra in (
                ("eef_pos", "end-effector-position", {"frame": "world", "unit": "m"}),
                ("eef_quat", "end-effector-orientation", {"frame": "world", "format": "xyzw"}),
                ("gripper_qpos", "panda-gripper-joint-position", {"frame": "panda-fingers", "unit": "m"}),
            ):
                name = f"robot{arm}_{key}"
                fields[name] = {"semantic": semantic, "dtype": "float32", "shape": list(demo["obs"][name].shape[1:]), **extra}
        if observation == "low-dim":
            fields["object"] = {"semantic": "robomimic-" + task + "-object-state",
                                "dtype": "float32", "shape": list(demo["obs"]["object"].shape[1:])}
        else:
            # Match the paper's RGB recipes; Tool Hang uses the larger side and wrist views.
            size = 240 if task == "tool_hang" else 84
            kwargs.update(camera_heights=size, camera_widths=size)
            for camera in ROBOMIMIC_CAMERAS.get(task, ("agentview", "robot0_eye_in_hand")):
                fields[camera + "_image"] = rgb(camera, [size, size, 3], "HWC")
    action = {"semantic": "robomimic-panda-delta-osc-and-gripper", "shape": [7 * arms], "controller": "osc-pose-delta",
              "frame": "world", "unit": "controller-normalized", "rotation": "delta-axis-angle",
              "gripper": "signed-open-close", "order": [f"robot{arm}_{key}" for arm in range(arms)
              for key in ("dx", "dy", "dz", "drx", "dry", "drz", "gripper")]}
    profile = {"id": "robomimic-" + task.replace("_", "-") + "-" + observation + "/1",
               "observations": fields, "action": action}
    environment = {"kind": "robomimic", "tasks": [task], "horizon": horizon, "envMetadata": metadata}
    return environment, profile


def register(args, image, name, environment, profile, source, paths, score, **extras):
    root = args.source.resolve()
    files = {path: file_digest(root / path) for path in paths}
    reference = {"id": name + "/1", "environment": environment,
                 "parameters": {"replanSteps": 1, "settleSteps": 0, "controlHz": 20},
                 "reference": {"evaluation": source, "files": files, **extras},
                 "benchmarkProfile": profile, "observationMap": {key: key for key in profile["observations"]},
                 "scoreName": score, "scoreUnit": "task"}
    benchmark = {"name": name, "path": str(root), "adapter": str(HERE / "adapter.py"), "config": {
        "image": image, "python": "/usr/local/bin/python",
        "renderer": "osmesa",
        "reference": json.dumps(reference, separators=(",", ":")),
        "profileDigest": digest(reference), "implementationDigest": implementation_digest(),
    }}
    output = args.output_dir / name
    output.mkdir(parents=True, exist_ok=True)
    for filename, content in (("benchmark.json", benchmark), ("reference.json", reference)):
        (output / filename).write_text(json.dumps(content, indent=2) + "\n")
    print(name, len(environment["tasks"]), "tasks")


def register_robomimic(args, image):
    import runpy

    paths = ("robomimic/__init__.py", "robomimic/envs/env_robosuite.py", "robomimic/scripts/run_trained_agent.py")
    registry = runpy.run_path(str(args.source / paths[0]))["DATASET_REGISTRY"]
    for task in PH_TASKS:
        dataset = args.data / (task + ".hdf5")
        horizon = registry[task]["ph"]["low_dim"]["horizon"]
        dataset_digest = file_digest(dataset)
        for observation in ("low-dim", "image"):
            environment, profile = robomimic_reference(task, dataset, observation, horizon)
            register(args, image, profile["id"].split("/", 1)[0] + "-native", environment, profile, ROBOMIMIC,
                     paths, "RoboMimic PH " + observation + " success", robosuite=ROBOSUITE,
                     datasetDigest=dataset_digest)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=("robomimic",))
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--robosuite-source", type=Path, required=True)
    parser.add_argument("--data", type=Path)
    parser.add_argument("--output-dir", type=Path)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--build-tag")
    operation.add_argument("--benchmark-image")
    args = parser.parse_args()
    sources = {"robomimic": (args.source, ROBOMIMIC, ["robomimic"]),
               "robosuite": (args.robosuite_source, ROBOSUITE, ["robosuite"])}
    record = {"kind": args.kind,
              "sources": {name: spec["commit"] for name, (_, spec, _) in sources.items()},
              "dockerfile": file_digest(HERE / "robomimic.Dockerfile"), "entrypoint": ["python"]}
    if args.build_tag:
        build(args, sources, record)
        return
    if not args.output_dir or not args.data:
        parser.error("RoboMimic registration requires --output-dir and --data")
    for root, source, _ in sources.values():
        check_source(root, source, {})
        subprocess.run(["git", "-C", str(root), "diff", "--quiet", "HEAD", "--"], check=True)
    image = require_image(args.benchmark_image, record)
    register_robomimic(args, image)


if __name__ == "__main__":
    main()
