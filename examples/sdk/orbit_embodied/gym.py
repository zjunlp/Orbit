"""Single native Gymnasium environment, without upstream rollout workers or scheduling."""

from __future__ import annotations

import importlib
from pathlib import Path
import numpy as np

from .binding import reference_horizon, seed_asset
from .driver import StepResult


class GymBenchmark:
    action_size = 7
    settle_steps = 0

    def __init__(self, reference, task):
        self.reference, self.task = reference, task
        config = reference["environment"]
        if task not in config["tasks"]:
            raise ValueError("task is not in the frozen environment catalog")
        self.horizon = reference_horizon(reference, task)
        self.env, self.video = None, None
        self.success = False
        self.steps = 0
        self.native_action = None
        self.reset_actions = []

    def reset_seed(self, sample):
        if sample["taskId"] != self.task or sample["initialStateDigest"] != seed_asset(self.reference, self.task):
            raise ValueError("reset recipe differs from the frozen sample plan")
        return sample["environmentSeed"] + int(sample["initialStateId"])

    def reset(self, sample):
        seed = self.reset_seed(sample)
        config = self.reference["environment"]
        module = importlib.import_module(config["registration"])
        getattr(module, config["register"])()
        import gymnasium
        self.env = gymnasium.make(self.task)
        self.capture_native_step()
        observation, _info = self.env.reset(seed=seed)
        return self.observation(observation)

    def capture_native_step(self):
        native = self.env.unwrapped
        native = getattr(native, "env", getattr(native, "_env", None))
        if native is None:
            raise ValueError("the frozen wrapper has no native action boundary")
        step = native.step
        def record(action, *args, **kwargs):
            self.native_action = np.asarray(action).tolist()
            return step(action, *args, **kwargs)
        native.step = record

    def observation(self, raw):
        result = {}
        for name, description in self.reference["benchmarkProfile"]["observations"].items():
            value = raw[name]
            result[name] = str(value) if description["dtype"] == "string" else np.asarray(value, dtype=description["dtype"])
        return result

    @staticmethod
    def state(observation):
        return {name: np.asarray(value).tolist() for name, value in observation.items() if name.startswith("state.")}

    def step(self, action):
        keys = self.reference["benchmarkProfile"]["action"]["order"]
        command = {"action." + key: np.asarray(action[index:index + 1]) for index, key in enumerate(keys)}
        raw, reward, done, truncated, info = self.env.step(command)
        success = bool(info["success"])
        self.success = self.success or success
        self.steps += 1
        finished = self.steps % self.reference["parameters"]["replanSteps"] == 0 and self.success
        return StepResult(self.observation(raw), float(reward), bool(done or truncated or finished),
                          success, native_action=self.native_action)

    def result(self):
        return {"success": self.success, "source": "native Gymnasium info.success", "task": self.task}

    def start_video(self, directory):
        import imageio
        self.video = imageio.get_writer(str(Path(directory) / "video.mp4"), fps=self.reference["parameters"]["controlHz"])

    def record_frame(self, observation):
        name = next(k for k, v in self.reference["benchmarkProfile"]["observations"].items() if v["semantic"] == "rgb")
        self.video.append_data(observation[name])

    def finish_video(self):
        if self.video is not None:
            self.video.close()
            self.video = None

    def close(self):
        if self.env is not None:
            self.env.close()
