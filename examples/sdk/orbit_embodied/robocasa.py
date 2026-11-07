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

        if math.ceil(get_task_horizon(self.task.split("/", 1)[1]) * 1.5) != self.horizon:
            raise ValueError("RoboCasa task horizon differs from the frozen reference")
        np.random.seed(seed)
        self.env = gymnasium.make(self.task, split=config["split"], seed=seed)
        self.capture_native_step()
        observation, _ = self.env.reset()
        return self.observation(observation)

    def step(self, action):
        from robocasa.utils.env_utils import convert_action

        raw, reward, _, _, info = self.env.step(convert_action(action))
        self.success = bool(info["success"])
        return StepResult(self.observation(raw), float(reward), self.success,
                          self.success, native_action=self.native_action)
