"""Build the native RoboMME simulator or register its entire public test split."""

import argparse
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import digest, file_digest
from native_runtime import build_native_image, check_policy_source, export_source, require_image, write_benchmark
from orbit_embodied.robomme import HORIZON, SUITES, test_catalog


SOURCE = {"repository": "https://github.com/RoboMME/robomme_benchmark",
          "commit": "777c595d9c443405fdc145452929bc5890c13e19"}
MANISKILL = {"repository": "https://github.com/YinpeiDai/ManiSkill",
             "commit": "07be6fbc66350ddca200abfb0a11b692f078f7fd"}
DOCKERFILE = Path(__file__).with_name("robomme.Dockerfile")
NAME = "robomme-test-joint-native"


def reference(source):
    catalog = test_catalog(source)
    files = {
        str(path.relative_to(source)): file_digest(path)
        for path in sorted((source / "src/robomme/env_metadata/test").glob("*.json"))
    }
    order = [f"joint_{idx}" for idx in range(1, 8)]
    cameras = {
        camera + "_rgb": {"semantic": "rgb", "dtype": "uint8", "shape": [256, 256, 3],
                          "camera": camera, "layout": "HWC", "format": "RGB-native"}
        for camera in ("front", "wrist")
    }
    profile = {"id": "robomme-panda-joint-angle/1", "observations": {
        **cameras,
        "joint_state": {"semantic": "panda-joint-and-gripper-state", "dtype": "float32", "shape": [8],
                        "frame": "panda-joints", "unit": "radians-and-meters",
                        "order": [*order, "left_finger_position"]},
        "instruction": {"semantic": "language-instruction", "dtype": "string", "shape": []},
    }, "action": {
        "semantic": "absolute-joint-target-and-gripper-command", "shape": [8], "controller": "robomme-joint-angle",
        "frame": "panda-joints", "unit": "radians-and-signed-command", "rotation": "joint-angles",
        "gripper": "signed-open-positive", "order": [*order, "gripper_command"],
    }}
    return {"version": 1, "id": "robomme-public-test-joint-angle/1",
            "scoreName": "RoboMME native success", "scoreErrors": "fail", "scoreUnit": "sample",
            "reference": {"evaluation": SOURCE, "maniskill": MANISKILL, "files": files},
            "environment": {
                "kind": "robomme", "suite": "test", "tasks": list(catalog),
                "horizons": dict.fromkeys(catalog, HORIZON), "environmentSeed": 0,
                "testEpisodes": catalog, "initialStateCounts": {task: len(rows) for task, rows in catalog.items()},
                "initialStateDigests": {task: digest(rows) for task, rows in catalog.items()},
                "taskTags": {task: {"suite": suite} for suite, tasks in SUITES.items() for task in tasks},
                "reset": "public test metadata keyed by task and initialStateId",
            },
            "benchmarkProfile": profile, "observationMap": {name: name for name in profile["observations"]},
            "parameters": {"settleSteps": 0, "replanSteps": 16, "renderSize": 256, "successRule": "last"}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--build-tag")
    operation.add_argument("--benchmark-image")
    parser.add_argument("--maniskill-source", type=Path)
    parser.add_argument("--simulator-base")
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    check_policy_source(args.source, SOURCE)
    manifest = {"kind": NAME, "sources": {"robomme": SOURCE["commit"], "maniskill": MANISKILL["commit"]},
                "dockerfile": file_digest(DOCKERFILE), "entrypoint": ["python"]}
    if args.build_tag:
        if not args.maniskill_source or not args.simulator_base:
            parser.error("--build-tag requires --maniskill-source and --simulator-base")
        with TemporaryDirectory(prefix="orbit-robomme-maniskill-") as temporary:
            maniskill = Path(temporary) / "maniskill"
            export_source(args.maniskill_source, MANISKILL, maniskill, ())
            build_native_image(args.build_tag, "robomme", args.source, SOURCE, DOCKERFILE, manifest,
                               ("src/robomme",), extra_contexts=(("maniskill", maniskill),),
                               build_args=("SIMULATOR_BASE=" + args.simulator_base,))
        return
    if not args.output_dir:
        parser.error("--benchmark-image requires --output-dir")
    image = require_image(args.benchmark_image, manifest)
    write_benchmark(args.output_dir, NAME, args.source, image, "vulkan", "python", reference(args.source), gpu_mem=10)


if __name__ == "__main__":
    main()
