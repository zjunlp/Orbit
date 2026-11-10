"""Expand initial states into a frozen sample plan; host requires only Python stdlib."""

import argparse
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "sdk"))
from orbit_embodied import digest
from orbit_embodied.binding import GENERATED_ENVIRONMENTS, check_distinct_resets, seed_asset
from orbit_embodied.libero_plus import catalog as libero_plus_catalog
from orbit_embodied.simpler import initial_state_count
from orbit_embodied.vlabench import initial_state_count as vlabench_state_count
from adapter import catalog


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference-source", type=Path, required=True)
    parser.add_argument("--reference-file", type=Path, default=HERE / "reference.json")
    parser.add_argument("--suite", default="libero_spatial")
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--task", action="append")
    selection.add_argument("--all-tasks", action="store_true",
                           help="Plan every task in the selected benchmark catalog")
    states = parser.add_mutually_exclusive_group(required=True)
    states.add_argument("--initial-state", action="append", type=int)
    states.add_argument("--all-initial-states", action="store_true",
                        help="Expand every initial state in a fixed native catalog")
    parser.add_argument("--environment-seed", type=int)
    parser.add_argument("--repetitions", type=int, default=1)
    args = parser.parse_args()
    reference = json.loads(args.reference_file.read_text())
    environment = reference.get("environment", {})
    kind = environment.get("kind")
    environment_seed = args.environment_seed
    if environment_seed is None:
        environment_seed = 0 if environment.get("protocol") == "rvt-test" else {"calvin": 0, "robodojo": 0, "vlabench": 42}.get(kind, 7)
    generated = kind in GENERATED_ENVIRONMENTS
    uint32_seed = kind in ("robocasa365", "robotwin", "robolab", "robodojo") or "simplerRobot" in environment
    if environment_seed < 0:
        raise ValueError("environment seed must be nonnegative")
    if generated:
        tasks = {task: {"tags": {"initialStateDigest": seed_asset(reference, task)}}
                 for task in environment["tasks"]}
    else:
        if kind == "libero-plus":
            if args.suite != environment["suite"]:
                parser.error("--suite must match the registered LIBERO-Plus suite")
            listing = libero_plus_catalog(args.reference_source, args.suite)
        else:
            listing = catalog(args.reference_source, args.suite)
        tasks = {task["id"]: task for task in listing if task["supported"]}
    items = []
    for task_id in tasks if args.all_tasks else args.task:
        if task_id in environment.get("unsupported", {}):
            raise ValueError("unsupported task " + task_id + ": " + environment["unsupported"][task_id])
        task = tasks[task_id]
        if kind == "calvin":
            count = len(environment["catalog"]["sequences"])
        elif kind == "libero-plus":
            count = int(task["tags"]["initialStateCount"])
        elif kind == "vlabench":
            count = vlabench_state_count(environment, task_id)
        elif kind in ("robocasa-v02", "rlbench"):
            count = environment.get("initialStateCount")
        else:
            count = initial_state_count(environment, task_id)
        if kind == "robodojo":
            count = len(environment.get("layouts", {}).get(task_id, {}).get(str(environment_seed), []))
            if not count:
                raise ValueError("no frozen RoboDojo layouts for the selected task and evaluation seed")
        if args.all_initial_states and count is None:
            parser.error("--all-initial-states requires a fixed native catalog")
        selected = range(count) if args.all_initial_states else args.initial_state
        limit = count if count is not None else 2 ** 31 if generated else 50
        for initial_state in selected:
            if not 0 <= initial_state < limit:
                raise ValueError("initial-state index exceeds the selected reset recipe")
            scene_seed = environment_seed if count is not None else environment_seed + initial_state
            if uint32_seed and scene_seed >= 2 ** 32:
                raise ValueError("scene seed must fit in an unsigned 32-bit integer")
            for repetition in range(args.repetitions):
                content = {"taskId": task_id, "benchmarkProfile": reference["id"],
                           "initialStateId": str(initial_state), "initialStateDigest": task["tags"]["initialStateDigest"],
                           "environmentSeed": environment_seed, "policySeed": 0, "repetition": repetition}
                items.append({"sampleId": digest(content), **content})
    if generated:
        check_distinct_resets(items, reference)
    result = {"version": 1, "items": items, "digest": digest(items)}
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
