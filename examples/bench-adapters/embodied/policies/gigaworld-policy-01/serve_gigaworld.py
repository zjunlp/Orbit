"""Serve the released GigaWorld-Policy-0.1 RoboCasa365 checkpoint offline."""

import argparse
import asyncio
import json
from pathlib import Path
import random

import numpy as np

from orbit_embodied.binding import digest, file_digest
from orbit_embodied.wire import serve_actions


CHUNK = 24
REPLAN = 20
RANDOMNESS = {"backend": "torch", "initialSeed": 42, "scope": "service"}
STATE_KEYS = (
    "state.base_position", "state.base_rotation", "state.end_effector_position_relative",
    "state.end_effector_rotation_relative", "state.gripper_qpos",
)


def asset_identity(root, release):
    for group, entries in release.items():
        directory = root / "wan" if group == "backbone" else root
        for name, checksum in entries.items():
            if file_digest(directory / name) != "sha256:" + checksum:
                raise ValueError("GigaWorld asset differs from the published release: " + name)
    return {"checkpointDigest": "sha256:" + release["checkpoint"]["model.pt"],
            "normalizationDigest": "sha256:" + release["normalization"]["norm_stats_delta.json"],
            "backboneDigest": digest(release["backbone"])}


def model_input(observation):
    return {
        "observation/image": observation["video.robot0_agentview_left"],
        "observation/wrist_image": observation["video.robot0_eye_in_hand"],
        "observation/right_image": observation["video.robot0_agentview_right"],
        "observation/state": np.concatenate([observation[field] for field in STATE_KEYS]),
        "prompt": observation["annotation.human.task_description"],
    }


def native_chunk(actions):
    actions = np.asarray(actions, dtype=np.float32)
    if actions.shape != (CHUNK, 12) or not np.isfinite(actions).all():
        raise ValueError("GigaWorld returned an invalid RoboCasa365 action chunk")
    # Convert the upstream LeRobot layout into the native RoboCasa HDF5 layout.
    return np.concatenate((actions[:, 5:], actions[:, :5]), axis=1)


def make_policy(root):
    import torch
    from transformers import AutoTokenizer, UMT5EncoderModel
    from inference_server import GWPPolicy, build_model, load_norm_stats

    seed = RANDOMNESS["initialSeed"]
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    dtype, device = torch.bfloat16, "cuda"
    backbone = root / "wan"
    model = build_model(str(backbone), str(root / "model.pt"), device=device, dtype=dtype)
    model["rng"] = torch.Generator(device=device).manual_seed(seed)
    stats = load_norm_stats(str(root / "norm_stats_delta.json"), 16, 12, device)
    tokenizer = AutoTokenizer.from_pretrained(backbone / "tokenizer", local_files_only=True)
    text_encoder = UMT5EncoderModel.from_pretrained(
        backbone / "text_encoder", dtype=torch.float16, local_files_only=True).to(device).eval()
    policy = GWPPolicy(model, stats, t5_embedding=None, tokenizer=tokenizer, text_encoder=text_encoder,
                       dst_size=(320, 256), num_steps=10, num_frames=CHUNK, action_chunk=CHUNK,
                       action_only=True, zero_action_dims=[3], ctrl_mode_dim=4, tshape=True, tshape_head_index=2)

    def infer(observation):
        return native_chunk(policy.infer(model_input(observation))["actions"])

    return infer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", required=True, type=Path)
    parser.add_argument("--checkpoint-digest", required=True)
    parser.add_argument("--normalization-digest", required=True)
    parser.add_argument("--backbone-digest", required=True)
    args = parser.parse_args()
    release = json.loads(Path(__file__).with_name("release.json").read_text())
    identity = asset_identity(args.weights, release)
    if identity != {"checkpointDigest": args.checkpoint_digest, "normalizationDigest": args.normalization_digest,
                    "backboneDigest": args.backbone_digest}:
        raise ValueError("GigaWorld weights differ from the frozen policy registration")
    metadata = {"actionSize": 12, "replanSteps": REPLAN,
                "orbit": {**identity, "randomness": RANDOMNESS}}
    asyncio.run(serve_actions(make_policy(args.weights), metadata, "0.0.0.0", 8000))


if __name__ == "__main__":
    main()
