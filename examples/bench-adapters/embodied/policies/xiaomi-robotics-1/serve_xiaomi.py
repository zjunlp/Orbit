"""Serve the published Xiaomi-Robotics-1 RoboCasa365 checkpoint over Orbit's policy wire."""

import argparse
import asyncio
import json
from pathlib import Path

import numpy as np

from orbit_embodied.binding import digest, file_digest
from orbit_embodied.wire import serve_actions


REPLAN = 16
RANDOMNESS = {"backend": "torch", "initialSeed": 0, "scope": "service"}
ROBOTS = "robocasa365"
REPOSITORY = "XiaomiRobotics/Xiaomi-Robotics-1-RoboCasa365"
REVISION = "3a6d0293bfa90759d34a7fc48c2c62413cd7bcf4"


def asset_identity(root, release):
    import hashlib

    checksums = {}
    for name, expected in release.items():
        path = root / name
        checksum = file_digest(path)
        if len(expected) == 40:
            blob = hashlib.sha1(("blob " + str(path.stat().st_size) + "\0").encode())
            blob.update(path.read_bytes())
            matches = blob.hexdigest() == expected
        else:
            matches = checksum == "sha256:" + expected
        if not matches:
            raise ValueError("Xiaomi Robotics-1 asset differs from its published revision: " + name)
        checksums[name] = checksum
    return digest(checksums), checksums["preprocessor_config.json"]


def model_observations(observation, camera_keys, state_encoder):
    images = {key: observation[key] for key in camera_keys}
    channels = {key: value for key, value in observation.items() if key.startswith("state.")}
    states = np.stack([state_encoder({key: value[index] for key, value in channels.items()})
                       for index in range(4)])
    return states, images


def make_policy(root):
    import torch
    from transformers import AutoModel, AutoProcessor
    from eval_robocasa365.entry import ACTION_DIM, CAMERA_KEYS, EvalClient, observation_to_state

    model = AutoModel.from_pretrained(root, trust_remote_code=True, local_files_only=True,
                                     attn_implementation="flash_attention_2", dtype=torch.bfloat16).cuda().eval()
    processor = AutoProcessor.from_pretrained(root, trust_remote_code=True, local_files_only=True, use_fast=False)
    if ROBOTS not in processor.list_robot_types():
        raise ValueError("Xiaomi Robotics-1 checkpoint lacks RoboCasa365 normalization")
    torch.manual_seed(RANDOMNESS["initialSeed"])

    class LocalClient(EvalClient):
        def __init__(self):
            self.processor = processor
            self.robot_type = ROBOTS
            self.crop_ratio = 0.95
            self.client = self.predict

        @torch.inference_mode()
        def predict(self, **inputs):
            tensors = {key: (value.to(device=model.device, dtype=model.dtype if value.is_floating_point() else value.dtype)
                             if isinstance(value, torch.Tensor) else value) for key, value in inputs.items()}
            output = model(**tensors).actions.cpu()
            return processor.decode_action(output, robot_type=ROBOTS)

    client = LocalClient()

    def infer(observation):
        states, images = model_observations(observation, CAMERA_KEYS, observation_to_state)
        actions = client.infer(states, images, observation["annotation.human.task_description"])
        if actions.ndim != 2 or actions.shape[1] != ACTION_DIM or len(actions) < REPLAN or not np.isfinite(actions).all():
            raise ValueError("Xiaomi Robotics-1 returned an invalid RoboCasa365 action chunk")
        return actions

    return infer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", required=True, type=Path)
    parser.add_argument("--checkpoint-digest", required=True)
    parser.add_argument("--normalization-digest", required=True)
    args = parser.parse_args()
    release = json.loads(Path(__file__).with_name("release.json").read_text())
    if asset_identity(args.weights, release) != (args.checkpoint_digest, args.normalization_digest):
        raise ValueError("Xiaomi Robotics-1 checkpoint differs from the frozen registration")
    metadata = {"actionSize": 12, "replanSteps": REPLAN, "orbit": {
        "checkpointDigest": args.checkpoint_digest, "normalizationDigest": args.normalization_digest,
        "randomness": RANDOMNESS,
    }}
    asyncio.run(serve_actions(make_policy(args.weights), metadata, "0.0.0.0", 8000))


if __name__ == "__main__":
    main()
