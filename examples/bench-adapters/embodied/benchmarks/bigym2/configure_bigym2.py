"""Build or register both pinned BiGym 2.0 learned-policy profiles."""

import argparse
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import check_source, file_digest
from native_runtime import build_native_image, read_native_catalog, require_image, write_benchmark
from orbit_embodied.bigym2 import profile


SOURCE = {"repository": "https://github.com/swirl-uk/BiGym2",
          "commit": "35ec40923421aff26ac2a525adea428567732898"}
SOURCE_FILES = ("bigym/loco/tasks.py", "bigym/loco/config.py", "bigym/loco/eval/protocol.py",
                "bigym/loco/eval/runner.py", "bigym/loco/demos/task_instructions.yaml", "uv.lock")
DOCKERFILE = Path(__file__).with_name("bigym2.Dockerfile")
PYTHON = "/opt/bigym2/.venv/bin/python"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--build-tag")
    mode.add_argument("--benchmark-image")
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()

    manifest = {"kind": "bigym2", "sources": {"bigym2": SOURCE["commit"]},
                "dockerfile": file_digest(DOCKERFILE), "entrypoint": [PYTHON]}
    if args.build_tag:
        build_native_image(args.build_tag, "bigym2", args.source, SOURCE, DOCKERFILE, manifest,
                           ("bigym", "pyproject.toml", "uv.lock", "README.md", "LICENSE", "NOTICE",
                            "THIRD_PARTY_NOTICES.md"))
        return
    if args.output_dir is None:
        parser.error("registration requires --output-dir")
    check_source(args.source, SOURCE, {})
    subprocess.run(["git", "-C", str(args.source), "diff", "--quiet", "HEAD", "--"], check=True)
    image = require_image(args.benchmark_image, manifest)
    catalog = read_native_catalog(image, "orbit_embodied.bigym2")
    tasks = catalog["tasks"]
    if (len(tasks) != 20 or sum(row["pitch"] for row in tasks.values()) != 14
            or (catalog["protocol"], catalog["seed"], catalog["episodes"]) != (1, 620000, 100)):
        raise ValueError("BiGym 2.0 official catalog differs from the pinned protocol")
    files = {name: file_digest(args.source / name) for name in SOURCE_FILES}
    for pitch in (False, True):
        selected = {task: row for task, row in tasks.items() if row["pitch"] == pitch}
        name = "bigym2-" + ("pitch" if pitch else "no-pitch") + "-native"
        benchmark_profile = profile(pitch, catalog["armOrder"])
        reference = {
            "id": name + "/1",
            "environment": {"kind": "bigym2", "tasks": list(selected),
                            "taskTitles": {task: row["instruction"] for task, row in selected.items()},
                            "horizons": {task: row["horizon"] for task, row in selected.items()},
                            "environmentSeed": catalog["seed"],
                            "initialStateCounts": dict.fromkeys(selected, catalog["episodes"])},
            "parameters": {"controlHz": 50, "settleSteps": 0, "renderSize": 84, "replanSteps": 1},
            "reference": {"evaluation": SOURCE, "files": files, "protocolVersion": catalog["protocol"],
                          "substrateVersion": catalog["substrate"]},
            "benchmarkProfile": benchmark_profile,
            "observationMap": {key: key for key in benchmark_profile["observations"]},
            "scoreName": "BiGym 2.0 success without falling", "scoreUnit": "sample",
        }
        write_benchmark(args.output_dir, name, args.source, image, "egl", PYTHON, reference, gpu_mem=4)
        print(f"{name} ({len(selected)} tasks, {len(selected) * catalog['episodes']} samples)")


if __name__ == "__main__":
    main()
