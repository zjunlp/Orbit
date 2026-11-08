"""Expand initial states into a frozen sample plan; host requires only Python stdlib."""

import argparse
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "sdk"))
from orbit_embodied import digest
from orbit_embodied.binding import GENERATED_ENVIRONMENTS, seed_asset
from adapter import catalog


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference-source", type=Path, required=True)
    parser.add_argument("--reference-file", type=Path, default=HERE / "reference.json")
    parser.add_argument("--suite", default="libero_spatial")
    parser.add_argument("--task", action="append", required=True)
    parser.add_argument("--initial-state", action="append", type=int, required=True)
    parser.add_argument("--environment-seed", type=int, default=7)
    parser.add_argument("--repetitions", type=int, default=1)
    args = parser.parse_args()
    reference = json.loads(args.reference_file.read_text())
    kind = reference.get("environment", {}).get("kind")
    generated = kind in GENERATED_ENVIRONMENTS
    if args.environment_seed < 0:
        raise ValueError("environment seed must be nonnegative")
    if generated:
        tasks = {task: {"tags": {"initialStateDigest": seed_asset(reference, task)}}
                 for task in reference["environment"]["tasks"]}
    else:
        tasks = {task["id"]: task for task in catalog(args.reference_source, args.suite)}
    items = []
    for task_id in args.task:
        task = tasks[task_id]
        for initial_state in args.initial_state:
            if not 0 <= initial_state < (2 ** 31 if generated else 50):
                raise ValueError("initial-state index exceeds the selected reset recipe")
            if kind in ("robocasa365", "robotwin") and not 0 <= args.environment_seed + initial_state < 2 ** 32:
                raise ValueError("scene seed must fit in an unsigned 32-bit integer")
            for repetition in range(args.repetitions):
                content = {"taskId": task_id, "benchmarkProfile": reference["id"],
                           "initialStateId": str(initial_state), "initialStateDigest": task["tags"]["initialStateDigest"],
                           "environmentSeed": args.environment_seed, "policySeed": 0, "repetition": repetition}
                items.append({"sampleId": digest(content), **content})
    if generated:
        from orbit_embodied.binding import check_distinct_resets
        check_distinct_resets(items)
    result = {"version": 1, "items": items, "digest": digest(items)}
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
