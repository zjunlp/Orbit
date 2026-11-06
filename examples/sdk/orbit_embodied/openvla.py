"""OpenVLA-OFT transport and native LIBERO observation/action semantics."""

from __future__ import annotations

import numpy as np

from .wire import pack, unpack


def libero_inputs(observation):
    from .openpi import quaternion_to_axis_angle

    def image(name):
        raw = np.asarray(observation[name])
        if raw.dtype != np.uint8 or raw.shape != (256, 256, 3):
            raise ValueError("OpenVLA LIBERO expects 256x256 HWC uint8 RGB: " + name)
        return np.ascontiguousarray(raw[::-1, ::-1])

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


def native_actions(actions):
    from .driver import EpisodeFailure

    chunk = np.asarray(actions)
    if chunk.shape != (8, 7) or chunk.dtype.kind not in "buif" or not np.isfinite(chunk).all():
        raise EpisodeFailure("policy_act", "OpenVLA-OFT requires a finite numeric (8, 7) action chunk",
                             rejected_actions=chunk)
    chunk = chunk.astype(np.result_type(chunk.dtype, np.float32), copy=True)
    chunk[:, -1] = -np.sign(chunk[:, -1] - 0.5)
    return chunk


class OpenVLAClient:
    """Send native observations; official image processing runs with the model."""

    def __init__(self, url, *, timeout=120, replan_steps=8):
        from websockets.sync.client import connect

        if replan_steps != 8:
            raise ValueError("the pinned OFT LIBERO recipe executes eight actions per chunk")
        self.replan_steps, self.timeout = replan_steps, timeout
        self.connection = connect(url, compression=None, max_size=64 * 1024 * 1024,
                                  open_timeout=timeout, close_timeout=5)
        try:
            self.metadata = unpack(self.connection.recv(timeout=timeout))
            if (not isinstance(self.metadata, dict) or self.metadata.get("ioAdapter") != "libero-native"
                    or self.metadata.get("actionChunkSize") != 8):
                raise ValueError("OpenVLA server I/O recipe differs from the frozen policy")
        except Exception:
            self.close()
            raise

    def reset(self, sample):
        if sample["policySeed"] != 0:
            raise ValueError("OpenVLA uses a seed-0 service stream without per-episode reseeding")

    def act(self, observation):
        from websockets.exceptions import ConnectionClosed
        from .driver import EpisodeFailure

        try:
            self.connection.send(pack(observation))
            response = self.connection.recv(timeout=self.timeout)
        except TimeoutError as exc:
            raise EpisodeFailure("call_watchdog", "OpenVLA inference deadline expired; request was not retried") from exc
        except (ConnectionClosed, OSError) as exc:
            raise EpisodeFailure("server_unreachable", str(exc)) from exc
        if isinstance(response, str):
            raise RuntimeError("OpenVLA inference error: " + response)
        return native_actions(unpack(response)["actions"])

    def close(self):
        self.connection.close()
