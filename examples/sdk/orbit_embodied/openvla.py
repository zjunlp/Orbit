"""OpenVLA-OFT transport and native LIBERO observation/action semantics."""

from __future__ import annotations

import numpy as np

from .openpi import WebSocketPolicy, libero_gripper, libero_rgb, quaternion_to_axis_angle
from .wire import pack, unpack


def libero_inputs(observation):
    def image(name):
        raw = np.asarray(observation[name])
        if raw.dtype != np.uint8 or raw.shape != (256, 256, 3):
            raise ValueError("OpenVLA LIBERO expects 256x256 HWC uint8 RGB: " + name)
        return libero_rgb(raw)

    position = np.asarray(observation["eef_position"])
    quaternion = np.asarray(observation["eef_quaternion"])
    gripper = np.asarray(observation["gripper_position"])
    if (position.shape != (3,) or quaternion.shape != (4,) or gripper.shape != (2,)
            or not all(np.isfinite(value).all() for value in (position, quaternion, gripper))):
        raise ValueError("OpenVLA LIBERO expects finite position, xyzw quaternion and two gripper joints")
    if not isinstance(observation["instruction"], str) or not observation["instruction"].strip():
        raise ValueError("OpenVLA requires a nonempty task instruction")
    return {"full_image": image("front_rgb"), "wrist_image": image("wrist_rgb"),
            "state": np.concatenate((position, quaternion_to_axis_angle(quaternion), gripper))}


def raw_actions(actions):
    from .driver import EpisodeFailure

    chunk = np.asarray(actions)
    if chunk.shape != (8, 7) or chunk.dtype.kind not in "buif" or not np.isfinite(chunk).all():
        raise EpisodeFailure("policy_act", "OpenVLA-OFT requires a finite numeric (8, 7) action chunk",
                             rejected_actions=chunk)
    return chunk


def native_actions(actions):
    return libero_gripper(raw_actions(actions))


class OpenVLAClient(WebSocketPolicy):
    """Send native observations; official image processing runs with the model."""

    name = "OpenVLA"
    conversion = "libero-gripper"

    def __init__(self, url, *, timeout=120, replan_steps=8):
        if replan_steps != 8:
            raise ValueError("the pinned OFT LIBERO recipe executes eight actions per chunk")
        self.replan_steps = replan_steps
        self.connect(url, timeout, pack, unpack)

    def check_metadata(self, metadata):
        if (not isinstance(metadata, dict) or metadata.get("ioAdapter") != "libero-native"
                or metadata.get("actionChunkSize") != 8):
            raise ValueError("OpenVLA server I/O recipe differs from the frozen policy")

    def reset(self, sample):
        if sample["policySeed"] != 0:
            raise ValueError("OpenVLA uses a seed-0 service stream without per-episode reseeding")

    def act(self, observation):
        return raw_actions(self.infer(observation)["actions"])
