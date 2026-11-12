"""Serve the OpenPI DROID joint-position baseline for MolmoSpaces."""

import argparse
import asyncio
from pathlib import Path

import numpy as np

from orbit_embodied.assets import tree_digest
from orbit_embodied.binding import file_digest


CHUNK = 8
NORMALIZATION = "assets/droid/norm_stats.json"


def droid_inputs(observation):
    gripper = np.clip(observation["state.gripper"][0] / 0.824033, 0, 1)
    return {
        "observation/exterior_image_1_left": observation["front_rgb"],
        "observation/wrist_image_left": observation["wrist_rgb"],
        "observation/joint_position": observation["state.arm"],
        "observation/gripper_position": np.asarray(gripper).reshape(1),
        "prompt": observation["instruction"].lower(),
    }


def droid_actions(actions):
    actions = np.asarray(actions)
    if actions.ndim != 2 or actions.shape[1] != 8 or len(actions) < CHUNK or not np.isfinite(actions).all():
        raise ValueError("expected finite OpenPI DROID joint-position actions")
    chunk = actions[:CHUNK].copy()
    chunk[:, 7] = np.where(chunk[:, 7] > 0.5, 255, 0)
    return chunk


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--checkpoint-digest", required=True)
    parser.add_argument("--normalization-digest", required=True)
    args = parser.parse_args()
    if (tree_digest(args.checkpoint) != args.checkpoint_digest
            or file_digest(args.checkpoint / NORMALIZATION) != args.normalization_digest):
        raise ValueError("DROID checkpoint differs from the frozen registration")

    from openpi.policies.policy_config import create_trained_policy
    from openpi.training.config import get_config
    from orbit_embodied.wire import serve_actions

    policy = create_trained_policy(get_config("pi05_droid_jointpos"), args.checkpoint)

    def infer(observation):
        return droid_actions(policy.infer(droid_inputs(observation))["actions"])

    metadata = {"actionSize": 8, "replanSteps": CHUNK, "orbit": {
        "checkpointDigest": args.checkpoint_digest, "normalizationDigest": args.normalization_digest,
        "randomness": {"backend": "jax", "initialKey": 0, "scope": "service"},
    }}
    asyncio.run(serve_actions(infer, metadata, "0.0.0.0", 8000))


if __name__ == "__main__":
    main()
