"""RoboCasa365 native PandaOmron episodes using the pinned OpenPI evaluation recipe."""

from functools import lru_cache
import math
import os
import shutil

import numpy as np

from .assets import tree_digest
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

        scale = config.get("horizonScale", 1.5)
        if math.ceil(get_task_horizon(self.task.split("/", 1)[1]) * scale) != self.horizon:
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

    def step(self, action):
        from robocasa.utils.env_utils import convert_action

        raw, reward, done, _, info = self.env.step(convert_action(action))
        native_success = bool(info["success"])
        self.steps += 1
        parameters = self.reference["parameters"]
        if parameters.get("successRule") == "chunk-last-any":
            terminated = bool(done or self.steps == self.horizon)
            if terminated or self.steps % parameters["replanSteps"] == 0:
                self.success |= native_success
        else:
            self.success = terminated = native_success
        return StepResult(self.observation(raw), float(reward), terminated,
                          native_success, native_action=self.native_action)
