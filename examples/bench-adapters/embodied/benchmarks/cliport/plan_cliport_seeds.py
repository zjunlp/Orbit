"""Generate the frozen CLIPort test seed prefix with the pinned native oracle."""

import argparse
from concurrent.futures import ProcessPoolExecutor
from functools import partial
import json
import os
import sys
import tempfile

from orbit_embodied.cliport import ASSETS_ROOT, SUCCESS_REWARD, TEST_SEED, native_catalog, start_test_episode


def qualified_episodes(name, episodes):
    # Upstream names temporary URDFs using the seeded Python RNG.
    with tempfile.TemporaryDirectory(prefix="cliport-oracle-") as scratch:
        previous = tempfile.tempdir
        tempfile.tempdir = scratch
        try:
            return name, rollout_oracle(name, episodes)
        finally:
            tempfile.tempdir = previous


def rollout_oracle(name, episodes):
    from cliport import tasks
    from cliport.environments.environment import Environment
    import pybullet

    env = Environment(ASSETS_ROOT, disp=False, shared_memory=False, hz=480)
    accepted = []
    try:
        task = tasks.names[name]()
        oracle = task.oracle(env)
        for seed in range(TEST_SEED, TEST_SEED + 20000, 2):
            observation = start_test_episode(env, task, seed)
            info, total = env.info, 0.0
            horizon = task.max_steps
            for _ in range(horizon):
                action = oracle.act(observation, info)
                observation, reward, done, info = env.step(action)
                total += reward
                if done:
                    break
            if total > SUCCESS_REWARD:
                accepted.append({"seed": seed, "horizon": horizon})
                if len(accepted) == episodes:
                    print(f"{name} ({episodes} accepted seeds, last seed {seed})", file=sys.stderr, flush=True)
                    return accepted
    finally:
        pybullet.disconnect()
    raise RuntimeError(f"{name}: found only {len(accepted)} oracle-qualified test seeds")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--episodes", type=int, default=100)
    parser.add_argument("--jobs", type=int, default=1)
    args = parser.parse_args()
    if not 1 <= args.episodes <= 100 or args.jobs < 1:
        parser.error("episodes must be between 1 and 100, jobs must be positive")
    # Process-local PyBullet and RNG state are required by the upstream simulator.
    catalog = native_catalog()
    with ProcessPoolExecutor(max_workers=min(args.jobs, len(catalog), os.cpu_count() or 1)) as executor:
        rows = dict(executor.map(partial(qualified_episodes, episodes=args.episodes), catalog))
    # PyBullet can leave a partial line on stdout when a worker exits.
    print("\nORBIT_CLIPORT_EPISODES=" + json.dumps(rows), flush=True)


if __name__ == "__main__":
    main()
