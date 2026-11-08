"""Freeze the accepted seed prefix of the native RoboTwin 2.0 evaluator."""

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_embodied.binding import digest, seed_asset
from orbit_embodied.evidence import write_json
from orbit_embodied.robotwin import RoboTwinBenchmark


def sample_plan(reference, tasks, seed, trials, max_candidates):
    environment = reference["environment"]
    if environment["kind"] != "robotwin":
        raise ValueError("expected a frozen RoboTwin reference")
    if not tasks or len(set(tasks)) != len(tasks) or not set(tasks) <= set(environment["tasks"]):
        raise ValueError("select distinct tasks from the frozen RoboTwin catalog")
    start = 100000 * (1 + seed)
    if not (0 <= seed and 1 <= trials <= max_candidates <= 2 ** 31
            and start + max_candidates <= 2 ** 32):
        raise ValueError("invalid native seed or candidate search bounds")

    items = []
    for task in tasks:
        benchmark = RoboTwinBenchmark(reference, task)
        initial_digest = seed_asset(reference, task)
        accepted = 0
        for offset in range(max_candidates):
            if not benchmark.expert_accepts(start + offset, offset):
                continue
            content = {"taskId": task, "benchmarkProfile": reference["id"],
                       "initialStateId": str(offset), "initialStateDigest": initial_digest,
                       "environmentSeed": start, "policySeed": 0, "repetition": 0}
            items.append({**content, "sampleId": digest(content)})
            accepted += 1
            if accepted == trials:
                break
        if accepted != trials:
            raise ValueError(f"{task}: only {accepted} of {trials} expert-accepted seeds within the search bound")
    return {"version": 1, "items": items, "digest": digest(items)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference-file", type=Path, required=True)
    parser.add_argument("--task", action="append", help="repeat to select tasks; defaults to the full catalog")
    parser.add_argument("--seed", type=int, default=0, help="seed argument to the native evaluator")
    parser.add_argument("--trials", type=int, default=100)
    parser.add_argument("--max-candidates", type=int, default=10000, help="seed search limit per task")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    reference = json.loads(args.reference_file.read_text())
    tasks = args.task or reference["environment"]["tasks"]
    plan = sample_plan(reference, tasks, args.seed, args.trials, args.max_candidates)
    write_json(args.output, plan)


if __name__ == "__main__":
    main()
