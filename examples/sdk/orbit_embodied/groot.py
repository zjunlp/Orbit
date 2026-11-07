"""Bounded GR00T ZeroMQ transport; observation semantics belong to endpoint profiles."""

from __future__ import annotations

import numpy as np

from .wire import pack, unpack

LIBERO_ORDER = ["x", "y", "z", "roll", "pitch", "yaw", "gripper"]
ROBOCASA_ACTIONS = {
    "end_effector_position": 3, "end_effector_rotation": 3, "gripper_close": 1,
    "base_motion": 4, "control_mode": 1,
}


def libero_inputs(observation):
    from .openpi import libero_rgb, quaternion_to_axis_angle
    rotation = quaternion_to_axis_angle(observation["eef_quaternion"])
    result = {"video.image": libero_rgb(observation["front_rgb"]),
              "video.wrist_image": libero_rgb(observation["wrist_rgb"]),
              "state.gripper": np.asarray(observation["gripper_position"], dtype=np.float32),
              "annotation.human.action.task_description": observation["instruction"]}
    for index, key in enumerate(("x", "y", "z")):
        result["state." + key] = np.asarray([observation["eef_position"][index]], dtype=np.float32)
    for index, key in enumerate(("roll", "pitch", "yaw")):
        result["state." + key] = np.asarray([rotation[index]], dtype=np.float32)
    return result


class GrootClient:
    def __init__(self, url, profile, *, timeout=120, replan_steps=8, io_adapter="gr00t-flat"):
        import zmq
        self.profile, self.replan_steps = profile, replan_steps
        self.io_adapter = io_adapter
        if io_adapter == "libero-native":
            self.order = LIBERO_ORDER
        elif io_adapter == "robocasa-native":
            self.order = list(ROBOCASA_ACTIONS)
        elif io_adapter == "gr00t-flat":
            self.order = profile["action"]["order"]
        else:
            raise ValueError("unsupported GR00T I/O adapter")
        self.conversion = "libero-gripper" if io_adapter == "libero-native" else None
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
                provided = set(profile["observations"]) if io_adapter != "libero-native" else {
                    "video.image", "video.wrist_image", "state.x", "state.y", "state.z",
                    "state.roll", "state.pitch", "state.yaw", "state.gripper",
                    "annotation.human.action.task_description"}
                if not required.issubset(provided):
                    raise ValueError("GR00T modalities differ from the frozen observation profile")
            action = modalities["action"]
            if action["modality_keys"] != self.order:
                raise ValueError("GR00T action ordering differs from the frozen profile")
            if list(action["delta_indices"]) != list(range(len(action["delta_indices"]))):
                raise ValueError("GR00T action times must be contiguous and start at zero")
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
            if self.io_adapter == "robocasa-native" and value.shape[2] != ROBOCASA_ACTIONS[name]:
                raise ValueError("RoboCasa GR00T action field has the wrong width: " + name)
            fields.append(value[0])
        chunk = np.concatenate(fields, axis=-1)
        if chunk.dtype.kind not in "buif" or not np.isfinite(chunk).all():
            from .driver import EpisodeFailure
            raise EpisodeFailure("policy_act", "GR00T returned non-numeric or non-finite raw actions",
                                 rejected_actions=chunk)
        return chunk

    def close(self):
        self.socket.close(linger=0)
        self.context.term()
