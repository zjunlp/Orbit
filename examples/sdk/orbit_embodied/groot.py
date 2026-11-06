"""Bounded GR00T ZeroMQ transport; observation semantics belong to endpoint profiles."""

from __future__ import annotations

import io
import numpy as np

LIBERO_ORDER = ["x", "y", "z", "roll", "pitch", "yaw", "gripper"]


def libero_inputs(observation):
    from .openpi import quaternion_to_axis_angle
    rotation = quaternion_to_axis_angle(observation["eef_quaternion"])
    result = {"video.image": np.ascontiguousarray(observation["front_rgb"][::-1, ::-1]),
              "video.wrist_image": np.ascontiguousarray(observation["wrist_rgb"][::-1, ::-1]),
              "state.gripper": np.asarray(observation["gripper_position"], dtype=np.float32),
              "annotation.human.action.task_description": observation["instruction"]}
    for index, key in enumerate(("x", "y", "z")):
        result["state." + key] = np.asarray([observation["eef_position"][index]], dtype=np.float32)
    for index, key in enumerate(("roll", "pitch", "yaw")):
        result["state." + key] = np.asarray([rotation[index]], dtype=np.float32)
    return result


def pack(value):
    import msgpack
    import msgpack_numpy

    def encode(item):
        if isinstance(item, np.ndarray) and item.dtype.hasobject:
            raise ValueError("object arrays are not supported by the policy transport")
        return msgpack_numpy.encode(item)
    return msgpack.packb(value, default=encode)


def unpack(value):
    import msgpack
    import msgpack_numpy

    def decode(item):
        if item.get(b"nd", item.get("nd")) and item.get(b"kind", item.get("kind")) in (b"O", "O"):
            raise ValueError("object arrays are not supported by the policy transport")
        if item.get("__ndarray_class__", item.get(b"__ndarray_class__")):
            return np.load(io.BytesIO(item.get("as_npy", item.get(b"as_npy"))), allow_pickle=False)
        return msgpack_numpy.decode(item)
    return msgpack.unpackb(value, object_hook=decode, raw=False)


class GrootClient:
    def __init__(self, url, profile, *, timeout=120, replan_steps=8, io_adapter="gr00t-flat"):
        import zmq
        self.profile, self.replan_steps = profile, replan_steps
        self.io_adapter = io_adapter
        self.order = LIBERO_ORDER if io_adapter == "libero-native" else profile["action"]["order"]
        if io_adapter not in ("gr00t-flat", "libero-native"):
            raise ValueError("unsupported GR00T I/O adapter")
        self.context = zmq.Context()
        self.socket = self.context.socket(zmq.REQ)
        self.socket.setsockopt(zmq.LINGER, 0)
        self.socket.setsockopt(zmq.IMMEDIATE, 1)
        self.socket.setsockopt(zmq.RCVTIMEO, int(timeout * 1000))
        self.socket.setsockopt(zmq.SNDTIMEO, int(timeout * 1000))
        self.socket.setsockopt(zmq.MAXMSGSIZE, 64 * 1024 * 1024)
        self.socket.connect(url)
        try:
            self.metadata = self.call("orbit_identity")
            if not isinstance(self.metadata, dict):
                raise ValueError("GR00T server identity must be an object")
            modalities = self.call("get_modality_config")
            import json
            modalities = {key: value.get("as_json", value) for key, value in modalities.items()}
            modalities = {key: json.loads(value) if isinstance(value, str) else value for key, value in modalities.items()}
            for key in ("video", "state", "language"):
                if modalities[key]["delta_indices"] != [0]:
                    raise ValueError("this connector requires single-observation temporal inputs")
                required = {name if key == "language" else key + "." + name for name in modalities[key]["modality_keys"]}
                provided = set(profile["observations"]) if io_adapter == "gr00t-flat" else {
                    "video.image", "video.wrist_image", "state.x", "state.y", "state.z",
                    "state.roll", "state.pitch", "state.yaw", "state.gripper",
                    "annotation.human.action.task_description"}
                if not required.issubset(provided):
                    raise ValueError("GR00T modalities differ from the frozen observation profile")
            action = modalities["action"]
            if action["modality_keys"] != self.order:
                raise ValueError("GR00T action ordering differs from the frozen profile")
            if len(action["delta_indices"]) < replan_steps:
                raise ValueError("GR00T action horizon is shorter than the execution horizon")
        except Exception:
            self.close()
            raise

    def call(self, endpoint, data=None):
        import zmq
        from .driver import EpisodeFailure
        request = {"endpoint": endpoint}
        if data is not None:
            request["data"] = data
        try:
            self.socket.send(pack(request))
            reply = unpack(self.socket.recv())
        except zmq.Again as exc:
            self.close()
            raise EpisodeFailure("call_watchdog", "GR00T call deadline expired; request was not retried") from exc
        except zmq.ZMQError as exc:
            self.close()
            raise EpisodeFailure("server_unreachable", str(exc)) from exc
        if isinstance(reply, dict) and "error" in reply:
            raise RuntimeError("GR00T inference error: " + str(reply["error"]))
        return reply

    def reset(self, sample):
        if sample["policySeed"] != 0:
            raise ValueError("this service uses a fresh seed-0 random stream per trial")
        self.call("reset", {"options": None})

    def act(self, observation):
        if self.io_adapter == "libero-native":
            observation = libero_inputs(observation)
        inputs = {}
        for name, value in observation.items():
            inputs[name] = [value] if isinstance(value, str) else np.asarray(value)[None, None]
        reply = self.call("get_action", {"observation": inputs, "options": None})
        actions, _info = reply
        fields = []
        for name in self.order:
            value = np.asarray(actions["action." + name])
            if value.ndim != 3 or value.shape[0] != 1:
                raise ValueError("GR00T action field requires shape (1, horizon, dimension)")
            fields.append(value[0])
        chunk = np.concatenate(fields, axis=-1)
        if self.io_adapter == "libero-native":
            chunk[:, -1] = -np.sign(2 * chunk[:, -1] - 1)
        return chunk

    def close(self):
        self.socket.close(linger=0)
        self.context.term()
