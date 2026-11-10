"""Explicit hold-position calibration fixture; not a trained policy or positive oracle."""

import argparse
import asyncio
from pathlib import Path
from urllib.request import urlopen

import numpy as np

from orbit_embodied.binding import digest, file_digest
from orbit_embodied.wire import serve_actions


NORMALIZATION = digest({"normalization": "native absolute DROID joints and binary gripper", "version": 1})


def hold(observation, replan_steps):
    joints = np.asarray(observation["joint_position"], dtype=np.float32)
    gripper = np.asarray(observation["gripper_position"], dtype=np.float32)
    if joints.shape != (7,) or gripper.shape != (1,) or not np.isfinite(np.r_[joints, gripper]).all():
        raise ValueError("hold calibration requires the native seven-joint and one-gripper observation")
    action = np.r_[joints, (gripper > 0.5).astype(np.float32)]
    return np.repeat(action[None], replan_steps, axis=0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--replan-steps", type=int, default=1)
    parser.add_argument("--healthcheck", action="store_true")
    args = parser.parse_args()
    if args.healthcheck:
        with urlopen("http://127.0.0.1:8000/healthz", timeout=3) as response:
            if response.status != 200:
                raise RuntimeError("hold calibration is not ready")
        return
    if args.replan_steps <= 0:
        parser.error("replan steps must be positive")
    metadata = {"calibration": True, "actionSize": 8, "replanSteps": args.replan_steps, "orbit": {
        "checkpointDigest": file_digest(Path(__file__)), "normalizationDigest": NORMALIZATION,
        "randomness": {"backend": "stateless", "scope": "stateless"},
    }}
    asyncio.run(serve_actions(lambda observation: hold(observation, args.replan_steps),
                              metadata, "0.0.0.0", 8000))


if __name__ == "__main__":
    main()
