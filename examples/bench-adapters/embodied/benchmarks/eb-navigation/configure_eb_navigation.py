"""Build or register the five official sets of EB-Navigation scenes."""

import argparse
from pathlib import Path
import stat
import sys
import tempfile
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import digest, file_digest
from native_runtime import (build_native_image, check_policy_source, export_source, image_id,
                            require_image, write_benchmark)
from orbit_embodied.eb_navigation import DATASETS, HORIZON, RENDER_SIZE, VIDEO_FPS, read_catalog, semantic_profile

SOURCE = {"repository": "https://github.com/EmbodiedBench/EmbodiedBench",
          "commit": "9be4e980e9cd6bcb38373cd4aab7c32724bdd401"}
SEENAV = {"repository": "https://github.com/WzcTHU/SeeNav-Agent",
          "commit": "7ed6a59052701951bdb2c7d51dd6d9103219cf3e"}
THOR_BUILD = "thor-CloudRendering-f0825767cd50d69f666c7f282e54abfe58f1e917"
THOR_DIGEST = "sha256:1fd5f998644a6dd522a4cf6604c05360a75a5c27f450a7486c20e52dc2b67bb9"
DOCKERFILE = Path(__file__).with_name("eb-navigation.Dockerfile")
PYTHON = "/opt/eb-navigation/bin/python"
NAME = "eb-navigation-seenav"
UPSTREAM_ENV = Path("embodiedbench/envs/eb_navigation/EBNavEnv.py")
PROJECTION = Path("verl-agent/agent_system/environments/env_package/ebnav/utils")


def reference(source):
    catalog = read_catalog(source / DATASETS)
    profile = semantic_profile()
    files = sorted((source / DATASETS).glob("*.json"))
    return {
        "id": NAME + "/1", "scoreName": "EB-Navigation task success", "scoreErrors": "exclude",
        "reference": {"evaluation": SOURCE, "visualPrompt": SEENAV, "ai2thorBuild": THOR_DIGEST,
                      "files": {p.relative_to(source).as_posix(): file_digest(p)
                                for p in [*files, source / UPSTREAM_ENV]}},
        "benchmarkProfile": profile,
        "observationMap": {name: name for name in profile["observations"] if name != "navigation_pose"},
        "parameters": {"replanSteps": 1, "settleSteps": 0, "renderSize": RENDER_SIZE, "successRule": "last"},
        "environment": {"kind": "eb-navigation", "environmentSeed": 0, "horizon": HORIZON, "controlHz": VIDEO_FPS,
                        "catalog": catalog, "tasks": list(catalog),
                        "taskTitles": {task: row["instruction"] for task, row in catalog.items()},
                        "taskTags": {task: {"split": task.split(":")[0], "scene": row["scene"]}
                                     for task, row in catalog.items()},
                        "initialStateCounts": dict.fromkeys(catalog, 1),
                        "initialStateDigests": {task: digest(row) for task, row in catalog.items()}},
    }


def extract_unity(archive_path, target):
    if file_digest(archive_path) != THOR_DIGEST:
        raise ValueError("AI2-THOR release ZIP differs from the official checksum")
    with zipfile.ZipFile(archive_path) as archive:
        archive.extractall(target)
        for entry in archive.infolist():
            path = target / entry.filename
            if path.is_file() and stat.S_IMODE(entry.external_attr >> 16) & stat.S_IXUSR:
                path.chmod(0o755)
    (target / THOR_BUILD).chmod(0o755)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--seenav-source", type=Path, required=True)
    parser.add_argument("--base-image", default="ubuntu:24.04")
    parser.add_argument("--unity-zip", type=Path)
    parser.add_argument("--output-dir", type=Path)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--build-tag")
    operation.add_argument("--benchmark-image")
    args = parser.parse_args()
    check_policy_source(args.source, SOURCE)
    check_policy_source(args.seenav_source, SEENAV)
    profile = reference(args.source)
    manifest = {"kind": NAME, "sources": [SOURCE["commit"], SEENAV["commit"]],
                "base": image_id(args.base_image), "dockerfile": file_digest(DOCKERFILE),
                "catalog": digest(profile["reference"]["files"]), "unity": THOR_DIGEST, "entrypoint": [PYTHON]}
    if args.build_tag:
        if not args.unity_zip:
            parser.error("--build-tag requires --unity-zip")
        with tempfile.TemporaryDirectory(prefix="orbit-eb-navigation-") as directory:
            root = Path(directory)
            seenav, thor = root / "seenav", root / "thor"
            export_source(args.seenav_source, SEENAV, seenav, ("SeeNav/envs/EBNavEnv.py", str(PROJECTION)))
            extract_unity(args.unity_zip, thor)
            build_native_image(args.build_tag, "eb_navigation", args.source, SOURCE, DOCKERFILE, manifest,
                               (str(DATASETS),), extra_contexts=(("seenav", seenav), ("thor", thor)),
                               build_args=("BENCHMARK_BASE=" + args.base_image,))
        return
    if not args.output_dir:
        parser.error("--benchmark-image requires --output-dir")
    image = require_image(args.benchmark_image, manifest)
    write_benchmark(args.output_dir, NAME, args.source, image, "vulkan", PYTHON, profile, gpu_mem=16)


if __name__ == "__main__":
    main()
