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


def libero_rgb(raw):
    """LIBERO renders upside down; both reference runners rotate cameras by 180 degrees."""
    return np.ascontiguousarray(np.asarray(raw)[::-1, ::-1])


def libero_gripper(chunk):
    """Model gripper in [0, 1] (1 closes) to LIBERO's -1 close / +1 open, as both reference runners do."""
    converted = np.array(chunk, dtype=np.result_type(np.asarray(chunk).dtype, np.float32), copy=True)
    converted[:, -1] = -np.sign(2 * converted[:, -1] - 1)
    return converted


# Named, deterministic raw-to-native action conversions; evidence records the name and the raw chunk.
CONVERSIONS = {"libero-gripper": libero_gripper}


def prepare_libero_observation(observation, resize_size=224):
    from openpi_client import image_tools

    def image(name):
        raw = np.asarray(observation[name])
        if raw.dtype != np.uint8 or raw.ndim != 3 or raw.shape[-1] != 3:
            raise ValueError("expected HWC uint8 RGB camera: " + name)
        rotated = libero_rgb(raw)
        return image_tools.convert_to_uint8(image_tools.resize_with_pad(rotated, resize_size, resize_size))

    state = np.concatenate((observation["eef_position"],
                            quaternion_to_axis_angle(observation["eef_quaternion"]),
                            observation["gripper_position"]))
    if state.shape != (8,) or not np.isfinite(state).all():
        raise ValueError("expected finite LIBERO state: position, axis-angle and two gripper joints")
    return {"observation/image": image("front_rgb"),
            "observation/wrist_image": image("wrist_rgb"),
            "observation/state": state, "prompt": str(observation["instruction"])}


class WebSocketPolicy:
    """One bounded request per inference over a binary WebSocket; stateful calls are never retried."""

    name = "policy"
    conversion = None

    def connect(self, url, timeout, packb, unpackb):
        from websockets.sync.client import connect

        self.timeout, self.packb, self.unpackb = timeout, packb, unpackb
        self.connection = connect(url, compression=None, max_size=64 * 1024 * 1024,
                                  open_timeout=timeout, close_timeout=5)
        try:
            self.metadata = unpackb(self.connection.recv(timeout=timeout))
            self.check_metadata(self.metadata)
        except Exception:
            self.close()
            raise

    def check_metadata(self, metadata):
        if not isinstance(metadata, dict):
            raise ValueError(self.name + " server metadata is not an object")

    def infer(self, payload):
        from websockets.exceptions import ConnectionClosed
        from .driver import EpisodeFailure

        try:
            self.connection.send(self.packb(payload))
            response = self.connection.recv(timeout=self.timeout)
        except TimeoutError as exc:
            raise EpisodeFailure("call_watchdog", self.name + " inference deadline expired; request was not retried") from exc
        except (ConnectionClosed, OSError) as exc:
            raise EpisodeFailure("server_unreachable", str(exc)) from exc
        if isinstance(response, str):
            raise RuntimeError(self.name + " inference error: " + response)
        return self.unpackb(response)

    def close(self):
        self.connection.close()


class OpenPIClient(WebSocketPolicy):
    """OpenPI's stock server: JAX key 0 per service, no claimed remote reset."""

    name = "OpenPI"

    def __init__(self, url, *, timeout=120, replan_steps=5):
        from openpi_client import msgpack_numpy

        if replan_steps < 1:
            raise ValueError("replan_steps must be positive")
        self.replan_steps = replan_steps
        self.connect(url, timeout, msgpack_numpy.packb, msgpack_numpy.unpackb)

    def reset(self, sample):
        if sample.get("policySeed", 0) != 0:
            raise ValueError("the stock OpenPI service uses JAX key 0; per-episode reseeding is unavailable")

    def act(self, observation):
        return self.infer(prepare_libero_observation(observation))["actions"]
