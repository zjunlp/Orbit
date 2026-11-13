"""Serve the OpenDM VLA-Arena policy with native Arena action decoding."""

import argparse
import asyncio
from pathlib import Path

import numpy as np

from orbit_embodied.assets import tree_digest
from orbit_embodied.binding import file_digest


HORIZON = 20
REPLAN = 10


def model_state(observation):
    quat = np.array(observation["eef_quaternion"], copy=True)
    quat[3] = np.clip(quat[3], -1.0, 1.0)
    denominator = np.sqrt(1.0 - quat[3] * quat[3])
    axis_angle = (np.zeros(3) if np.isclose(denominator, 0.0)
                  else quat[:3] * 2.0 * np.arccos(quat[3]) / denominator)
    return np.concatenate((observation["eef_position"], axis_angle,
                           observation["gripper_position"])).astype(np.float32)


def native_actions(raw):
    actions = np.asarray(raw, dtype=np.float32)
    if actions.shape != (HORIZON, 7) or not np.isfinite(actions).all():
        raise ValueError("DM0.5 Arena must return twenty finite seven-dimensional actions")
    actions = actions.copy()
    dimensions = (0, 1, 2, 6)
    values = actions[:, dimensions]
    actions[:, dimensions] = np.where(values < -0.5, -1, np.where(values > 0.5, 1, 0))
    return actions


def build_model(weights):
    from dm05_vla_arena import DM05Exp
    import torch

    experiment = DM05Exp()
    experiment.model_config.model_name_or_path = str(weights)
    experiment.model_config.vision_attn_implementation = "sdpa"
    experiment._initialize_inference_runtime()
    torch.manual_seed(0)
    return experiment.inference_config


def predict(model, observation):
    from opendm.dataset.vla_arena import VLA_ARENA_EEF_STATE_DESC
    from PIL import Image

    return model._predict({
        "images": [Image.fromarray(observation[key]) for key in ("front_rgb", "wrist_rgb")],
        "prompt": observation["instruction"],
        "state": model_state(observation),
        "meta_data": {"robot_type": "Franka", "speed": "0.5", "control_mode": None,
                      "state_desc": VLA_ARENA_EEF_STATE_DESC},
    })


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--checkpoint-digest", required=True)
    parser.add_argument("--normalization-digest", required=True)
    args = parser.parse_args()
    if (tree_digest(args.weights) != args.checkpoint_digest
            or file_digest(args.weights / "norm_stats.json") != args.normalization_digest):
        raise ValueError("DM0.5 assets differ from the frozen registration")

    from orbit_embodied.wire import serve_actions

    model = build_model(args.weights)
    identity = {"checkpointDigest": args.checkpoint_digest, "normalizationDigest": args.normalization_digest,
                "randomness": {"backend": "torch", "initialSeed": 0, "scope": "service"}}
    metadata = {"actionSize": 7, "replanSteps": REPLAN, "orbit": identity}
    asyncio.run(serve_actions(lambda observation: native_actions(predict(model, observation)),
                              metadata, "0.0.0.0", 8000))


if __name__ == "__main__":
    main()
