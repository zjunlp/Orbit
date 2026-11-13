"""Serve the official depth-free LingBot-VLA RoboTwin recipe."""

import argparse
import asyncio
import os
from pathlib import Path

import numpy as np

from orbit_embodied.assets import tree_digest
from orbit_embodied.binding import file_digest


CHUNK = 50
NORM = Path("/opt/lingbot/assets/norm_stats/robotwin_50.json")


def model_inputs(observation):
    return {
        "observation.images.cam_high": observation["head_camera"],
        "observation.images.cam_left_wrist": observation["left_camera"],
        "observation.images.cam_right_wrist": observation["right_camera"],
        "observation.state": np.asarray(observation["joint_state"], dtype=np.float32),
        "task": observation["instruction"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--checkpoint-digest", required=True)
    parser.add_argument("--normalization-digest", required=True)
    args = parser.parse_args()
    if tree_digest(args.weights) != args.checkpoint_digest or file_digest(NORM) != args.normalization_digest:
        raise ValueError("LingBot-VLA assets differ from the frozen registration")
    os.environ["QWEN25_PATH"] = str(args.weights / "qwen")

    from deploy.lingbot_vla_policy import LingbotVLAServer, set_seed_everywhere
    from orbit_embodied.wire import serve_actions

    set_seed_everywhere(0)
    model = LingbotVLAServer(str(args.weights / "policy"), use_length=CHUNK, robot_norm_path=str(NORM))

    def reset():
        model.reset(robo_name="robotwin")

    def infer(observation):
        actions = np.asarray(model.infer(model_inputs(observation))["action"])
        if actions.shape != (CHUNK, 14) or not np.isfinite(actions).all():
            raise ValueError("LingBot-VLA must return fifty finite RoboTwin joint targets")
        return actions

    metadata = {"actionSize": 14, "replanSteps": CHUNK, "orbit": {
        "checkpointDigest": args.checkpoint_digest, "normalizationDigest": args.normalization_digest,
        "randomness": {"backend": "torch", "initialSeed": 0, "scope": "service"},
    }}
    asyncio.run(serve_actions(infer, metadata, "0.0.0.0", 8000, reset=reset))


if __name__ == "__main__":
    main()
