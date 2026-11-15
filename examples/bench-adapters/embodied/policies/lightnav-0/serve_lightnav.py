"""Serve LightNav-0 on the explicitly declared HSSD-OV discrete controller."""

import argparse
import asyncio
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from orbit_embodied.binding import digest, file_digest
from orbit_embodied.conversions import LIGHTNAV_HSSD_VELOCITY

RELEASE = Path(__file__).with_name("release.json")
RANDOMNESS = {"backend": "stateless", "scope": "stateless"}


def identity(root, release):
    files = release["files"]
    for name, expected in files.items():
        path = root / name
        if expected.startswith("sha256:"):
            valid = file_digest(path) == expected
        else:
            content = path.read_bytes()
            blob = f"blob {len(content)}\0".encode("ascii") + content
            valid = "git:" + hashlib.sha1(blob).hexdigest() == expected
        if not valid:
            raise ValueError("LightNav checkpoint file differs from the pinned release: " + name)
    return {"checkpointDigest": digest({k: v for k, v in files.items() if k.endswith(".safetensors")}),
            "normalizationDigest": digest({k: v for k, v in files.items() if not k.endswith(".safetensors")})}


@contextmanager
def release_directory(weights, release):
    with TemporaryDirectory(prefix="orbit-lightnav-") as directory:
        root = Path(directory)
        for name in release["files"]:
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to((weights / name).resolve(strict=True))
        yield root


def make_policy(weights):
    import numpy as np
    from lightnav.habitat.runner import HabitatEvalConfig, build_velocity_policy
    from lightnav.inference.config import InferenceConfig
    from lightnav.inference.engine import build_engine

    path = str(weights)
    cfg = HabitatEvalConfig(model_path=path, backend="hf", force_stop_at_max_steps=False)
    engine, bundle = build_engine(InferenceConfig(model_path=path, backend="hf"))
    policy = build_velocity_policy(cfg, engine, bundle, {"habitat_time_step": 0.1, "lin_vel_range": (0, 2.5),
                                                          "ang_vel_range": (-300, 300)})
    first = True

    def reset():
        nonlocal first
        first = True
        engine.reset_episode_state()

    def predict(observation):
        nonlocal first
        if first:
            policy.reset(observation)
            first = False
        velocity = policy.act(observation)["action_args"]
        decoded = "predicted_traj" in policy.get_info()
        return np.asarray([[velocity["linear_velocity"], velocity["angular_velocity"], decoded]], dtype=np.float64)

    return predict, reset


def main():
    from orbit_embodied.wire import serve_actions

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", required=True, type=Path)
    parser.add_argument("--checkpoint-digest", required=True)
    parser.add_argument("--normalization-digest", required=True)
    args = parser.parse_args()
    release = json.loads(RELEASE.read_text())
    with release_directory(args.weights, release) as weights:
        assets = identity(weights, release)
        if assets != {"checkpointDigest": args.checkpoint_digest, "normalizationDigest": args.normalization_digest}:
            raise ValueError("LightNav assets differ from the frozen registration")
        predict, reset = make_policy(weights)
        metadata = {"replanSteps": 1, "actionSize": 1, "actionConversion": LIGHTNAV_HSSD_VELOCITY,
                    "orbit": {**assets, "randomness": RANDOMNESS}}
        asyncio.run(serve_actions(predict, metadata, "0.0.0.0", 8000, reset=reset))


if __name__ == "__main__":
    main()
