"""Original RoboCasa v0.2 PandaOmron atomic evaluation."""

import numpy as np

from .driver import StepResult
from .gym import GymBenchmark
from .robocasa import prepare_assets


ASSETS_VIEW = "/opt/robocasa-v02/robocasa/models/assets"


class RoboCasaV02Benchmark(GymBenchmark):
    action_size = 7

    def reset(self, sample):
        seed = self.reset_seed(sample)
        assets = self.reference["environment"]["assets"]
        prepare_assets(assets["target"], ASSETS_VIEW, assets["digest"])
        from robocasa.utils.dataset_registry import SINGLE_STAGE_TASK_DATASETS
        from robocasa.utils.env_utils import create_env

        if SINGLE_STAGE_TASK_DATASETS[self.task]["horizon"] != self.horizon:
            raise ValueError("RoboCasa v0.2 native horizon differs from the frozen registry")
        np.random.seed(seed)
        size = self.reference["parameters"]["renderSize"]
        environment = self.reference["environment"]
        self.cameras = environment["cameras"]
        self.env = create_env(env_name=self.task, robots="PandaOmron", camera_names=self.cameras,
                              camera_widths=size, camera_heights=size, render_onscreen=False,
                              obj_instance_split=environment["objectSplit"],
                              layout_and_style_ids=environment["layoutStylePairs"], seed=seed)
        self.env.rng = np.random.default_rng(seed)
        if self.env.action_spec[0].shape != (12,):
            raise ValueError("RoboCasa v0.2 requires the 12-component PandaOmron controller")
        self.success, self.steps = False, 0
        raw = self.env.reset()
        self.instruction = self.env.get_ep_meta()["lang"]
        return self.observation(raw)

    def observation(self, raw):
        return {**{camera: np.ascontiguousarray(raw[camera + "_image"][::-1]) for camera in self.cameras},
                "instruction": self.instruction}

    def state(self, observation):
        return {"layoutId": int(self.env.layout_id), "styleId": int(self.env.style_id)}

    def step(self, action):
        command = np.zeros(12)
        command[:self.action_size] = action
        raw, _, _, _ = self.env.step(command)
        self.steps += 1
        self.success = bool(self.env._check_success())
        return StepResult(self.observation(raw), float(self.success),
                          self.success or self.steps == self.horizon, self.success,
                          native_action=command.tolist())

    def result(self):
        return {"success": self.success, "source": "RoboCasa v0.2 _check_success", "task": self.task}
