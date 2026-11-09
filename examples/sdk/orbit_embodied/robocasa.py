"""RoboCasa365 native PandaOmron episodes and their evaluation protocols."""

from functools import lru_cache
import os
import shutil

import numpy as np

from .assets import tree_digest
from .binding import robocasa_horizon
from .driver import StepResult
from .gym import GymBenchmark


@lru_cache(maxsize=1)
def prepare_assets(target, view, expected):
    if tree_digest(target) != expected:
        raise ValueError("RoboCasa asset contents differ from the frozen reference")
    # RoboCasa writes transient scaled XML beside each object. Only the directory view is writable.
    shutil.copytree(target, view, copy_function=os.symlink)


class RoboCasaBenchmark(GymBenchmark):
    action_size = 12

    def reset(self, sample):
        seed = self.reset_seed(sample)
        if not 0 <= seed < 2 ** 32:
            raise ValueError("RoboCasa365 scene seed must fit in an unsigned 32-bit integer")
        config = self.reference["environment"]
        assets = config["assets"]
        prepare_assets(assets["target"], assets["view"], assets["digest"])

        import robocasa  # Registers the native Gymnasium environments.
        import gymnasium
        from robocasa.utils.dataset_registry_utils import get_task_horizon

        if robocasa_horizon(get_task_horizon(self.task.split("/", 1)[1]), config) != self.horizon:
            raise ValueError("RoboCasa task horizon differs from the frozen reference")
        np.random.seed(seed)
        self.env = gymnasium.make(self.task, split=config["split"], seed=seed)
        self.capture_native_step()
        if self.task == "robocasa/DrinkwareConsolidation":
            observation = self.reset_drinkware()
        else:
            observation, _ = self.env.reset()
        self.success, self.steps = False, 0
        return self.observation(observation)

    def reset_drinkware(self):
        native = self.env.unwrapped.env
        reset = native.reset

        def reset_with_observation():
            observation = reset()
            if observation is None:
                # The pinned task opens a cabinet door after reset and drops the returned observation.
                native.sim.forward()
                return native._get_observations(force_update=True)
            return observation

        native.reset = reset_with_observation
        try:
            observation, _ = self.env.reset()
            return observation
        finally:
            del native.reset

    def step_native_env(self, action):
        from robocasa.utils.env_utils import convert_action

        result = self.env.step(convert_action(action))
        self.steps += 1
        return result

    def step(self, action):
        raw, reward, done, _, info = self.step_native_env(action)
        native_success = bool(info["success"])
        parameters = self.reference["parameters"]
        if parameters.get("successRule") == "chunk-last-any":
            terminated = bool(done or self.steps == self.horizon)
            if terminated or self.steps % parameters["replanSteps"] == 0:
                self.success |= native_success
        else:
            self.success = terminated = native_success
        return StepResult(self.observation(raw), float(reward), terminated,
                          native_success, native_action=self.native_action)


class RoboCasaDiffusionBenchmark(RoboCasaBenchmark):
    def reset(self, sample):
        self.previous_observation = {}
        self.previous_success = False
        return super().reset(sample)

    def observation(self, raw):
        current = super().observation(raw)
        history = {}
        for name, value in current.items():
            if isinstance(value, str):
                history[name] = self.previous_observation.setdefault(name, value)
            else:
                history[name] = np.stack((self.previous_observation.get(name, value), value))
                self.previous_observation[name] = history[name][-1].copy()
        return history

    def step(self, action):
        raw, reward, done, _, info = self.step_native_env(action)
        native_success = bool(info["success"])
        self.success |= native_success
        # The upstream runner reads info["success"][0] from the last two control steps.
        chunk_end = self.steps % self.reference["parameters"]["replanSteps"] == 0
        terminated = bool(done or self.steps == self.horizon or (chunk_end and self.previous_success))
        self.previous_success = native_success
        return StepResult(self.observation(raw), float(reward), terminated, native_success,
                          native_action=self.native_action, native_done=bool(done))

    @staticmethod
    def state(observation):
        return {name: value[-1].tolist() for name, value in observation.items() if name.startswith("state.")}

    def record_frame(self, observation):
        self.video.append_data(observation["video.robot0_agentview_right"][-1])
