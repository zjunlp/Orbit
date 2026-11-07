"""OpenPI's binary WebSocket protocol and LIBERO observation preprocessing."""

from __future__ import annotations

import math
import numpy as np


def quaternion_to_axis_angle(quaternion):
    # OpenPI's LIBERO runner uses robosuite's xyzw convention and this zero-angle rule.
    quat = np.array(quaternion, copy=True)
    quat[3] = np.clip(quat[3], -1.0, 1.0)
    denominator = np.sqrt(1.0 - quat[3] * quat[3])
    if math.isclose(denominator, 0.0):
        return np.zeros(3)
    return quat[:3] * 2.0 * math.acos(quat[3]) / denominator


def prepare_libero_observation(observation, resize_size=224):
    from openpi_client import image_tools

    def image(name):
        raw = np.asarray(observation[name])
        if raw.dtype != np.uint8 or raw.ndim != 3 or raw.shape[-1] != 3:
            raise ValueError("expected HWC uint8 RGB camera: " + name)
        rotated = np.ascontiguousarray(raw[::-1, ::-1])
        return image_tools.convert_to_uint8(image_tools.resize_with_pad(rotated, resize_size, resize_size))

    state = np.concatenate((observation["eef_position"],
                            quaternion_to_axis_angle(observation["eef_quaternion"]),
                            observation["gripper_position"]))
    if state.shape != (8,) or not np.isfinite(state).all():
        raise ValueError("expected finite LIBERO state: position, axis-angle and two gripper joints")
    return {"observation/image": image("front_rgb"),
            "observation/wrist_image": image("wrist_rgb"),
            "observation/state": state, "prompt": str(observation["instruction"])}


class OpenPIClient:
    """Bounded calls, with no retries of stateful inference or claimed remote reset."""

    def __init__(self, url, *, timeout=120, replan_steps=5):
        from openpi_client import msgpack_numpy
        from websockets.sync.client import connect

        if replan_steps < 1:
            raise ValueError("replan_steps must be positive")
        self.replan_steps = replan_steps
        self.timeout = timeout
        self.codec = msgpack_numpy
        self.connection = connect(url, compression=None, max_size=64 * 1024 * 1024,
                                  open_timeout=timeout, close_timeout=5)
        try:
            self.metadata = self.codec.unpackb(self.connection.recv(timeout=timeout))
            if not isinstance(self.metadata, dict):
                raise ValueError("OpenPI server metadata is not an object")
        except Exception:
            self.connection.close()
            raise

    def reset(self, sample):
        if sample.get("policySeed", 0) != 0:
            raise ValueError("the stock OpenPI service uses JAX key 0; per-episode reseeding is unavailable")

    def act(self, observation):
        from websockets.exceptions import ConnectionClosed
        from .driver import EpisodeFailure
        try:
            self.connection.send(self.codec.packb(prepare_libero_observation(observation)))
            response = self.connection.recv(timeout=self.timeout)
        except TimeoutError as exc:
            raise EpisodeFailure("call_watchdog", "OpenPI inference deadline expired; request was not retried") from exc
        except (ConnectionClosed, OSError) as exc:
            raise EpisodeFailure("server_unreachable", str(exc)) from exc
        if isinstance(response, str):
            raise RuntimeError("OpenPI inference error: " + response)
        return self.codec.unpackb(response)["actions"]

    def close(self):
        self.connection.close()
