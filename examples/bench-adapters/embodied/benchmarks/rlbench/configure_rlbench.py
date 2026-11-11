"""Register the native RLBench MT100 or RVT test suite."""

import argparse
import ast
import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import HERE, check_source, digest, file_digest, implementation_digest
from native_runtime import COPPELIASIM_SHA256, RVT, RVT_PLANNER, require_image, rlbench_sources, runtime_manifest


MT100_SOURCE = "rlbench/tasks/__init__.py"
RVT_TASK_SOURCE = "rvt/utils/rvt_utils.py"
RVT_CAMERAS = ("front", "left_shoulder", "right_shoulder", "wrist")
MT100_CAMERAS = ("front", "wrist")
DEMO_FILES = ("low_dim_obs.pkl", "variation_number.pkl")


def mt100_tasks(path):
    source = ast.parse(path.read_text())
    names = {alias.name: node.module.rsplit(".", 1)[1] for node in source.body
             if isinstance(node, ast.ImportFrom) and node.module.startswith("rlbench.tasks.")
             for alias in node.names}
    suites = {}

    def expand(node):
        if isinstance(node, ast.List):
            return [names[entry.id] for entry in node.elts]
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            return expand(node.left) + expand(node.right)
        if isinstance(node, ast.Subscript):
            key = node.slice.value if isinstance(node.slice, ast.Index) else node.slice
            return suites[node.value.id][ast.literal_eval(key)]
        raise ValueError("unexpected RLBench task split declaration")

    for node in source.body:
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Dict):
            name = node.targets[0].id
            suites[name] = {ast.literal_eval(key): expand(value)
                            for key, value in zip(node.value.keys, node.value.values)}
    tasks = suites["MT100_V1"]["train"]
    if len(set(tasks)) != 100 or len(tasks) != 100:
        raise ValueError("expected all 100 native RLBench MT100 tasks")
    return tasks


def rvt_tasks(path):
    source = ast.parse(path.read_text())
    value = next(node.value for node in source.body if isinstance(node, ast.Assign)
                 and any(isinstance(target, ast.Name) and target.id == "RLBENCH_TASKS" for target in node.targets))
    tasks = ast.literal_eval(value)
    if len(set(tasks)) != 18 or len(tasks) != 18:
        raise ValueError("expected the 18 published RVT task IDs")
    return tasks


def demo_directory(root, task, index):
    return Path(root) / task / "all_variations" / "episodes" / ("episode" + str(index))


def demo_fingerprints(root, tasks):
    return {task: [{name: file_digest(demo_directory(root, task, index) / name) for name in DEMO_FILES}
                   for index in range(25)] for task in tasks}


RVT_FILES = (RVT_TASK_SOURCE, "rvt/eval.py", "rvt/utils/custom_rlbench_env.py", RVT_PLANNER)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--pyrep-source", type=Path, required=True)
    parser.add_argument("--rvt-source", type=Path)
    parser.add_argument("--test-data", type=Path)
    parser.add_argument("--benchmark-image", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    rvt = args.rvt_source is not None
    if rvt != (args.test_data is not None):
        parser.error("--rvt-source and --test-data are required together for the RVT test suite")
    sources = rlbench_sources(rvt)
    kind = "rlbench-rvt18" if rvt else "rlbench-mt100"
    image = require_image(args.benchmark_image, runtime_manifest(kind, sources))
    root = (args.rvt_source if rvt else args.source).resolve()
    files = {name: file_digest(root / name) for name in (RVT_FILES if rvt else (MT100_SOURCE,))}
    source, pyrep = sources["rlbench"], sources["pyrep"]
    check_source(root, RVT if rvt else source, files)
    check_source(args.source, source, {})
    check_source(args.pyrep_source, pyrep, {})
    for repo in (root, args.source, args.pyrep_source):
        subprocess.run(["git", "-C", str(repo), "diff", "--quiet", "HEAD", "--"], check=True)
    tasks = rvt_tasks(root / RVT_TASK_SOURCE) if rvt else mt100_tasks(root / MT100_SOURCE)
    cameras = RVT_CAMERAS if rvt else MT100_CAMERAS
    fields = {camera + "_rgb": {"semantic": "rgb", "camera": camera, "dtype": "uint8", "layout": "HWC",
                               "shape": [128, 128, 3]} for camera in cameras}
    fields["instruction"] = {"semantic": "language-instruction", "dtype": "string", "shape": []}
    fields["state.gripper_open"] = {"semantic": "rlbench-gripper-open", "dtype": "float32", "shape": [1]}
    action = {"semantic": "rlbench-panda-joint-velocity", "controller": "joint-velocity-then-discrete-gripper",
              "shape": [8], "frame": "panda-joints", "unit": "rad/s", "rotation": "joint-velocity",
              "gripper": "binary-0-close-1-open", "order": [f"joint_{i + 1}" for i in range(7)] + ["gripper"]}
    if rvt:
        for camera in RVT_CAMERAS:
            fields[camera + "_points"] = {"semantic": "world-point-cloud", "camera": camera, "dtype": "float32",
                                          "layout": "HWC", "shape": [128, 128, 3], "frame": "world", "unit": "m"}
        fields["state.gripper_joints"] = {"semantic": "rlbench-panda-finger-position-clipped", "dtype": "float32",
                                          "shape": [2], "frame": "panda-fingers", "unit": "m"}
        fields["state.time"] = {"semantic": "rvt-time-in-state", "dtype": "float32", "shape": [1]}
        action = {"semantic": "rlbench-panda-absolute-ee-pose", "controller": "rvt-pose-via-planning-discrete-gripper",
                  "shape": [9], "frame": "world", "unit": "m-and-xyzw-quaternion", "rotation": "absolute-xyzw",
                  "gripper": "binary-0-close-1-open",
                  "order": ["x", "y", "z", "qx", "qy", "qz", "qw", "gripper", "ignore_collisions"]}
    else:
        fields["state.ee_pose"] = {"semantic": "rlbench-panda-position-orientation", "dtype": "float32",
                                   "shape": [7], "frame": "world", "unit": "m-and-xyzw-quaternion"}
        fields["state.joints"] = {"semantic": "rlbench-panda-joint-position", "dtype": "float32", "shape": [7],
                                  "frame": "panda-joints", "unit": "rad"}
    name = kind + "-native"
    profile = {"id": ("rlbench-panda-rvt-pose" if rvt else "rlbench-panda-joint-velocity") + "/1",
               "observations": fields, "action": action}
    environment = {"kind": "rlbench", "protocol": "rvt-test" if rvt else "mt100-seeded", "tasks": tasks,
                   "horizon": 25 if rvt else 200, "cameras": cameras}
    if rvt:
        environment.update(initialStateCount=25, assets={"dataset": "rlbench-rvt-test", "target": "/opt/rlbench-test"},
                           demoFiles=demo_fingerprints(args.test_data, tasks))
        environment["assets"]["digest"] = digest(environment["demoFiles"])
    reference = {
        "id": name + "/1", "environment": environment,
        "parameters": {"replanSteps": 1, "settleSteps": 0, "renderSize": 128, "controlHz": 20},
        "reference": {"evaluation": RVT if rvt else source, "rlbench": source, "pyrep": pyrep,
                      "coppeliasim": COPPELIASIM_SHA256, "files": files},
        "benchmarkProfile": profile,
        "observationMap": {key: key for key in fields},
        "scoreName": ("RLBench RVT-18" if rvt else "RLBench MT100 seeded") + " success", "scoreUnit": "task",
    }
    benchmark = {"name": name, "path": str(root), "adapter": str(HERE / "adapter.py"), "config": {
        "image": image, "python": "/usr/local/bin/rlbench-python", "renderer": "xvfb-glx",
        "reference": json.dumps(reference, separators=(",", ":")), "profileDigest": digest(reference),
        "implementationDigest": implementation_digest(),
    }}
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for filename, value in (("benchmark.json", benchmark), ("reference.json", reference)):
        (args.output_dir / filename).write_text(json.dumps(value, indent=2) + "\n")


if __name__ == "__main__":
    main()
