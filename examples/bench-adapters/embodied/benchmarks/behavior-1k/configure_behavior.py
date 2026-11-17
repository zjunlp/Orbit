"""Freeze the released catalog and original 2026 public-test recipe."""
import argparse
import csv
import json
import math
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from adapter import HERE, check_source, digest, file_digest, implementation_digest
from native_runtime import image_id
from orbit_embodied.behavior1k import SOURCE, DATA_ROOT, asset_digest, profile

SOURCE_FILES = ("OmniGibson/omnigibson/eval/evaluator.py", "OmniGibson/omnigibson/eval/eval.py",
                "OmniGibson/omnigibson/eval/r1pro.yaml", "OmniGibson/omnigibson/eval/policies.py",
                "OmniGibson/omnigibson/eval/utils/eval_utils.py",
                "OmniGibson/omnigibson/eval/wrappers/default_wrapper.py")


def catalog(source):
    names = sorted(p.name for p in (source / "bddl3/bddl/activity_definitions").iterdir()
                   if p.is_dir() and list(p.glob("*.bddl")))
    if not names:
        raise ValueError("Missing original BDDL activity definitions")
    return names


def reference(source, data, dataset):
    tasks = catalog(source)
    metadata = data / "2026-challenge-task-instances/metadata"
    with (metadata / "B100_task_misc.csv").open(newline="") as stream:
        rows = list(csv.DictReader(stream))
    indices = {row["Task"]: int(row["Task ID"]) for row in rows}
    stats = {row["task_name"]: row for row in
             (json.loads(line) for line in (metadata / "task.jsonl").read_text().splitlines() if line.strip())}
    if len(indices) != len(rows) or any(task not in tasks for task in indices):
        raise ValueError("Challenge metadata contains duplicate or unknown activities")
    supported = {task for task in indices if task in stats}
    unsupported = {task: "Not included in the prepared 2026 R1Pro public-test metadata"
                   for task in tasks if task not in supported}
    horizons = {task: int(float(stats[task]["length"]) * 1.5) for task in supported}
    if any(value <= 0 for value in horizons.values()):
        raise ValueError("Native human-demo budgets must be positive")
    if not (data / "omnigibson.key").is_file():
        raise ValueError("Install the licensed key through the official BEHAVIOR workflow")
    semantic = profile()
    return {"id": "behavior1k-2026-r1pro-public/1",
        "environment": {"kind": "behavior1k", "tasks": tasks, "unsupported": unsupported,
            "horizons": horizons, "initialStateCounts": {task: 20 for task in supported},
            "environmentSeed": 0, "taskIndices": indices,
            "assets": {"dataset": dataset, "target": DATA_ROOT, "digest": asset_digest(data)}},
        "parameters": {"settleSteps": 0, "renderSize": 224, "controlHz": 30, "replanSteps": 1},
        "reference": {"evaluation": SOURCE, "files": {name: file_digest(source / name) for name in SOURCE_FILES}},
        "benchmarkProfile": semantic, "observationMap": {key: key for key in semantic["observations"]},
        "scoreName": "BEHAVIOR native final Q-score", "scoreUnit": "task", "scoreErrors": "fail"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--catalog-only", action="store_true")
    parser.add_argument("--reference-only", action="store_true", help="Freeze installed data without a simulator image")
    parser.add_argument("--data", type=Path)
    parser.add_argument("--dataset", default="behavior1k-licensed-data")
    parser.add_argument("--benchmark-image")
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    source = args.source.resolve()
    check_source(source, SOURCE, {})
    subprocess.run(["git", "-C", str(source), "diff", "--quiet", "HEAD", "--", "OmniGibson", "bddl3", "joylo"], check=True)
    if args.catalog_only:
        print(json.dumps({"activities": catalog(source), "source": SOURCE, "native_started": False}))
        return
    if args.data is None or args.output_dir is None or (args.benchmark_image is None and not args.reference_only):
        parser.error("registration needs --data, --benchmark-image and --output-dir; --reference-only omits the image")
    ref = reference(source, args.data.resolve(), args.dataset)
    if args.reference_only:
        output = args.output_dir.resolve()
        output.mkdir(parents=True, exist_ok=True)
        (output / "reference.json").write_text(json.dumps(ref, indent=2) + "\n")
        print(json.dumps({"activities": len(ref["environment"]["tasks"]),
            "available": len(ref["environment"]["horizons"]), "native_started": False}))
        return
    image = image_id(args.benchmark_image)
    built = subprocess.check_output(["docker", "image", "inspect", "--format",
        '{{index .Config.Labels "org.orbit.behavior.source"}}', image], text=True).strip()
    if built != SOURCE["commit"]:
        raise ValueError("Use the supplied image recipe with the pinned source label")
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    resources = {"version": 1, "default": {"cpus": 8, "memGB": 32, "gpus": 1, "gpuMemGB": 16,
        "timeoutMin": 120, "confidence": "low",
        "evidence": "Original OmniGibson requires an RTX GPU and 32GB RAM; real task timings remain uncalibrated."}, "tasks": {task: {"timeoutMin": max(120, math.ceil((horizon + 2100) / 60))}
                for task, horizon in ref["environment"]["horizons"].items()}}
    benchmark = {"name": "behavior1k-r1pro-public", "path": str(source), "adapter": str(HERE / "adapter.py"),
        "resources": str(output / "resources.json"), "labels": {"identity": {"id": "behavior-1k", "name": "BEHAVIOR-1K"}},
        "config": {"image": image, "python": "/opt/conda/envs/behavior/bin/python",
            "simGpus": "1", "simGpuMemGB": "16", "renderer": "vulkan",
            "reference": json.dumps(ref, separators=(",", ":")), "profileDigest": digest(ref),
            "implementationDigest": implementation_digest()}}
    for name, value in (("reference.json", ref), ("benchmark.json", benchmark), ("resources.json", resources)):
        (output / name).write_text(json.dumps(value, indent=2) + "\n")
    print("Prepared BEHAVIOR registration; key values were not copied into records.")


if __name__ == "__main__":
    main()
