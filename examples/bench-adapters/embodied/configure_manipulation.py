"""Build pinned runtimes and register RoboMimic PH or the VIMA-Bench test partitions."""

import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from adapter import HERE, SDK, check_source, digest, file_digest, implementation_digest
from native_runtime import MANIFEST_LABEL, export_source, require_image


ROBOMIMIC = {"repository": "https://github.com/ARISE-Initiative/robomimic",
             "commit": "d309eaecc18acf4152a830a895a6984b8ac71b05"}
ROBOSUITE = {"repository": "https://github.com/ARISE-Initiative/robosuite",
             "commit": "51cc01785bab80ffeed20da15e67d7dd4140e76a"}
VIMA_BENCH = {"repository": "https://github.com/vimalabs/VIMABench",
              "commit": "97e0af11e126fd477c9d81eeabfb6c739021c680"}
VIMA_POLICY = {"repository": "https://github.com/vimalabs/VIMA",
               "commit": "8449837aa453f8ec9ba229cb956e3bbef5c796ea"}
VIEWS = ("front", "top")
PH_TASKS = ("lift", "can", "square", "transport", "tool_hang")
PARTITIONS = ("placement_generalization", "combinatorial_generalization",
              "novel_object_generalization", "novel_task_generalization")
ROBOMIMIC_CAMERAS = {
    "transport": ("shouldercamera0", "robot0_eye_in_hand", "shouldercamera1", "robot1_eye_in_hand"),
    "tool_hang": ("sideview", "robot0_eye_in_hand"),
}
PH_ENVS = dict(zip(PH_TASKS, ("Lift", "PickPlaceCan", "NutAssemblySquare", "TwoArmTransport", "ToolHang")))
# The catalog comes from the same installed package and constructor used to solve.
VIMA_CATALOG = """
import json
from vima_bench.tasks import ALL_TASKS, PARTITION_TO_SPECS
classes = {key.rsplit("/", 1)[-1]: value for key, value in ALL_TASKS.items()}
catalog = {}
for partition, entries in PARTITION_TO_SPECS["test"].items():
    horizons = catalog[partition] = {}
    for name, kwargs in entries.items():
        task = classes[name](debug=False, **(kwargs or {}))
        task.set_difficulty("easy")
        horizons[name] = task.oracle_max_steps + 2
print("ORBIT_VIMA_CATALOG=" + json.dumps(catalog), flush=True)
"""


def inputs(args):
    if args.kind == "robomimic":
        return {"robomimic": (args.source, ROBOMIMIC, ["robomimic"]),
                "robosuite": (args.robosuite_source, ROBOSUITE, ["robosuite"])}
    sources = {"vima-bench": (args.source, VIMA_BENCH, ["vima_bench"])}
    if args.policy_source:
        sources["vima-policy"] = (args.policy_source, VIMA_POLICY, ["vima", "scripts/example.py"])
    return sources


def manifest(kind, sources, target):
    record = {"kind": "vima-policy" if target == "policy" else kind,
              "sources": {name: spec["commit"] for name, (_, spec, _) in sources.items()},
              "dockerfile": file_digest(HERE / (kind + ".Dockerfile")), "entrypoint": ["python"]}
    if target == "policy":
        record["server"] = file_digest(HERE / "serve_vima.py")
        # Match the Dockerfile's COPY and the repository's .dockerignore.
        record["sdk"] = {
            path.name: file_digest(path)
            for path in sorted((SDK / "orbit_embodied").glob("*.py"))
            if not path.name.startswith("test_")
        }
    return record


def build(args, sources, record, target):
    with tempfile.TemporaryDirectory(prefix="orbit-manipulation-") as temporary:
        contexts = []
        for name, (root, source, paths) in sources.items():
            export_source(root, source, Path(temporary) / name, paths)
            contexts.extend(["--build-context", name + "=" + str(Path(temporary) / name)])
        label = MANIFEST_LABEL + "=" + json.dumps(record, sort_keys=True, separators=(",", ":"))
        subprocess.run(["docker", "build", "--label", "orbit.task=embodied-eval", "--label", label,
                        *(["--target", target] if target else []), *contexts,
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


def vima_profile():
    fields = {view + "_rgb": rgb(view, [3, 128, 256], "CHW") for view in VIEWS}
    fields.update({view + "_segm": {"semantic": "instance-segmentation", "camera": view,
                                     "dtype": "uint8", "shape": [128, 256]} for view in VIEWS})
    fields["ee"] = {"semantic": "vima-tool-suction-or-spatula", "dtype": "uint8", "shape": [1]}
    fields["instruction"] = {"semantic": "vima-template-with-placeholders", "dtype": "string", "shape": []}
    fields["prompt_context"] = {"semantic": "vima-msgpack-base64-prompt-assets-and-action-bounds",
                                "dtype": "string", "shape": []}
    action = {"semantic": "vima-pick-place-primitive-poses", "shape": [12], "controller": "vima-task-primitive",
              "frame": "world", "unit": "m-and-xyzw-quaternion", "rotation": "absolute-xyzw",
              "gripper": "native-suction-or-spatula", "order": [
                  prefix + "_" + key for prefix in ("pick", "place") for key in ("x", "y", "qx", "qy", "qz", "qw")]}
    return {"id": "vima-bench-primitive/1", "observations": fields, "action": action}


def register(args, image, name, environment, profile, source, paths, score, **extras):
    root = args.source.resolve()
    files = {path: file_digest(root / path) for path in paths}
    reference = {"id": name + "/1", "environment": environment,
                 "parameters": {"replanSteps": 1, "settleSteps": 0, "controlHz": 20 if args.kind == "robomimic" else 2},
                 "reference": {"evaluation": source, "files": files, **extras},
                 "benchmarkProfile": profile, "observationMap": {key: key for key in profile["observations"]},
                 "scoreName": score, "scoreUnit": "task"}
    benchmark = {"name": name, "path": str(root), "adapter": str(HERE / "adapter.py"), "config": {
        "image": image, "python": "/usr/local/bin/python",
        "renderer": "pybullet-direct" if args.kind == "vima-bench" else "osmesa",
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


def register_vima(args, image):
    raw = subprocess.check_output(["docker", "run", "--rm", "--network", "none", "--label", "orbit.task=embodied-eval",
                                   image, "-B", "-c", VIMA_CATALOG], text=True)
    record, = [line.partition("ORBIT_VIMA_CATALOG=")[2] for line in raw.splitlines() if "ORBIT_VIMA_CATALOG=" in line]
    catalog = json.loads(record)
    if set(catalog) != set(PARTITIONS) or len(set().union(*(set(tasks) for tasks in catalog.values()))) != 17:
        raise ValueError("unexpected VIMA-Bench test partitions")
    for partition in PARTITIONS:
        horizons = catalog[partition]
        name = "vima-bench-" + partition.replace("_", "-") + "-native"
        paths = ("vima_bench/tasks/__init__.py", "vima_bench/env/base.py",
                 "vima_bench/tasks/partition_files/" + partition + ".yaml")
        register(args, image, name, {"kind": "vima-bench", "partition": partition, "tasks": list(horizons),
                                    "horizons": horizons}, vima_profile(), VIMA_BENCH, paths, "VIMA-Bench " + partition)


def register_vima_policy(args, sources):
    from orbit_embodied.assets import tree_digest
    from serve_vima import CHECKPOINT, RANDOMNESS, T5_CONFIG, TOKENIZER

    for name in (CHECKPOINT, TOKENIZER, T5_CONFIG):
        if not (args.weights / name).is_file():
            raise ValueError("VIMA weights are missing " + name)
    if any(args.weights.rglob("*.partial*")):
        raise ValueError("VIMA weights contain partial downloads")
    image = require_image(args.policy_image, manifest(args.kind, sources, "policy"))
    weights, tokenizer = tree_digest(args.weights), file_digest(args.weights / TOKENIZER)
    name = "vima-20m"
    server = "/opt/vima/serve_vima.py"
    definition = {
        "name": name, "version": "1", "connector": "policy-ws", "port": 8000,
        "replanSteps": 1, "callTimeoutSec": 120, "randomness": RANDOMNESS, "profile": vima_profile(),
        "checkpointDigest": weights, "normalizationDigest": tokenizer,
        "weights": {"dataset": name, "target": "/weights"},
        "service": {"name": "policy", "image": image, "gpus": 0, "cpus": 4, "memGB": 8,
                    "command": [server, "--weights", "/weights", "--checkpoint-digest", weights,
                                "--normalization-digest", tokenizer],
                    "healthcheck": {"command": ["python", server, "--healthcheck"], "startPeriodSec": 120,
                                    "timeoutSec": 5, "intervalSec": 5, "retries": 30}},
    }
    (args.output_dir / "vima-20m-policy.json").write_text(json.dumps(definition, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=("robomimic", "vima-bench"))
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--robosuite-source", type=Path)
    parser.add_argument("--policy-source", type=Path)
    parser.add_argument("--data", type=Path)
    parser.add_argument("--policy-image")
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--output-dir", type=Path)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--build-tag")
    operation.add_argument("--benchmark-image")
    args = parser.parse_args()
    if args.kind == "robomimic" and not args.robosuite_source:
        parser.error("RoboMimic requires --robosuite-source")
    if args.kind != "vima-bench" and any((args.policy_source, args.policy_image, args.weights)):
        parser.error("the policy options are for VIMA only")
    if args.benchmark_image and len([value for value in (args.policy_source, args.policy_image, args.weights) if value]) not in (0, 3):
        parser.error("VIMA policy registration requires --policy-source, --policy-image and --weights together")
    sources = inputs(args)
    target = ("policy" if args.policy_source else "simulator") if args.kind == "vima-bench" else None
    record = manifest(args.kind, sources, target)
    if args.build_tag:
        build(args, sources, record, target)
        return
    if not args.output_dir or (args.kind == "robomimic" and not args.data):
        parser.error("registration requires --output-dir and RoboMimic requires --data")
    for root, source, _ in sources.values():
        check_source(root, source, {})
        subprocess.run(["git", "-C", str(root), "diff", "--quiet", "HEAD", "--"], check=True)
    simulator_sources = {name: value for name, value in sources.items() if name != "vima-policy"}
    image = require_image(args.benchmark_image, manifest(args.kind, simulator_sources, None))
    if args.kind == "robomimic":
        register_robomimic(args, image)
    else:
        register_vima(args, image)
        if args.policy_image:
            register_vima_policy(args, sources)


if __name__ == "__main__":
    main()
