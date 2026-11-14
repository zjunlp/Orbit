"""Build or register the complete LIBERO-Mem suite with its published initial states."""

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import HERE, digest, file_digest
from native_runtime import build_native_image, check_policy_source, image_id, read_native_catalog, require_image, write_benchmark
from orbit_embodied.libero_mem import SUITE

SOURCE = {"repository": "https://github.com/libero-mem/libero-mem",
          "commit": "0eee0defa4024e51511b6e15a79f30e9620209de"}
STATES = {"repository": "https://github.com/anHappyDog/RLinf",
          "commit": "8d0f7cffcd5d315182faa104adb31b9ca52de9e4"}
RECIPE = {"repository": "https://github.com/NVlabs/VoLoAgent",
          "commit": "b4e623079ca8498a16bcd5016920d71f76c44d30"}
DOCKERFILE = Path(__file__).with_name("libero-mem.Dockerfile")
PYTHON = "/opt/fast-wam-libero/bin/python"
STATE_HASHES = (
    "b637ecce05264cd0d5f80170889321182d6349df3a141abdc8cf239eef2baf91",
    "2f3edfb95535fc73c76d46ba5caffe75bfdbf5196d4854e2d0be9ce0efb48108",
    "e1ce62392e5d145502279406614166c94261150a6035ac1a66ed8f166202d5c5",
    "6640b99e40059218748e2e721aad5de19130c34a0e2f3d78f556c6558297c1f9",
    "37a80996c6e50be5e96fab2bf685f31b9e4f35b45f88430980879442336c26ed",
    "524d722aa186a112c4ed017c9cf79156e6dfe1ee4c39de158b962bbdea5d2077",
    "031f4fc2daaed19a703d1b3d95842575d029f15fc24ba9bf4e4aefa63c19b148",
    "1be455fd0887f1c455652d3e7230fdc42ca5f4c2a84dbda538e12920687ae3e1",
    "299ab2614ca353c8846e355d5d522f8887f49f2ef557c7a84765cc8454bfd084",
    "5c53433bf8e637932b6cd7bd60ae327d743f75ce2b7397b361d201eabbe78b96",
)


def expected_states(bddls):
    return {path.stem: "sha256:" + STATE_HASHES[int(path.name.split("_", 3)[2]) - 1] for path in bddls}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--base-image", required=True)
    parser.add_argument("--initial-states", type=Path)
    parser.add_argument("--output-dir", type=Path)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--build-tag")
    operation.add_argument("--benchmark-image")
    args = parser.parse_args()
    check_policy_source(args.source, SOURCE)
    bddls = sorted((args.source / "libero/libero/bddl_files" / SUITE).glob("*.bddl"))
    expected = expected_states(bddls)
    if len(expected) != 10:
        raise ValueError("LIBERO-Mem must expose all ten tasks")
    manifest = {"kind": "libero-mem", "source": SOURCE["commit"], "base": image_id(args.base_image),
                "dockerfile": file_digest(DOCKERFILE), "initialStates": digest(expected), "entrypoint": [PYTHON]}
    if args.build_tag:
        if not args.initial_states:
            parser.error("--build-tag requires --initial-states")
        assets = {path.stem: file_digest(path) for path in args.initial_states.glob("*.pruned_init")}
        if assets != expected:
            raise ValueError("initial-state files differ from the pinned LIBERO-Mem catalog")
        build_native_image(args.build_tag, "libero_mem", args.source, SOURCE, DOCKERFILE, manifest,
                           ("libero/libero", "thirdparty/robosuite/robosuite"),
                           extra_contexts=(("mem_states", args.initial_states.resolve()),),
                           build_args=("BENCHMARK_BASE=" + args.base_image,))
        return
    if not args.output_dir:
        parser.error("--benchmark-image requires --output-dir")
    image = require_image(args.benchmark_image, manifest)
    catalog = read_native_catalog(image, "orbit_embodied.libero_mem", python_path="/orbit-sdk:/opt/libero-mem")
    if ({task.split(":", 1)[1]: row["digest"] for task, row in catalog.items()} != expected
            or any(row["count"] != 20 for row in catalog.values())):
        raise ValueError("the benchmark image catalog differs from the pinned LIBERO-Mem files")
    template = json.loads((HERE / "reference.json").read_text())
    files = [*bddls, args.source / "libero/libero/envs/problems/libero_kitchen_tabletop_manipulation.py",
             args.source / "libero/libero/envs/bddl_base_domain.py"]
    reference = {
        "id": "libero-mem-native/2", "scoreName": "LIBERO-Mem subgoal completion rate",
        "scoreErrors": "exclude",
        "reference": {"evaluation": SOURCE, "initialStates": STATES, "policyRecipe": RECIPE,
                      "files": {p.relative_to(args.source).as_posix(): file_digest(p) for p in files}},
        "environment": {
            "kind": "libero-mem", "tasks": list(catalog), "environmentSeed": 42, "catalog": catalog,
            "initialStateCounts": {task: row["count"] for task, row in catalog.items()},
            "initialStateDigests": {task: row["digest"] for task, row in catalog.items()},
            "taskTitles": {task: row["instruction"] for task, row in catalog.items()},
            "horizons": {task: row["horizon"] for task, row in catalog.items()},
        },
        "benchmarkProfile": {**template["benchmarkProfile"], "id": "libero-mem-panda-raw/1"},
        "observationMap": template["observationMap"],
        "parameters": {**template["parameters"], "replanSteps": 8, "environmentSeed": 42},
    }
    write_benchmark(args.output_dir, "libero-mem-native", args.source, image, "osmesa", PYTHON, reference)


if __name__ == "__main__":
    main()
