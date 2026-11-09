"""RLBench native task resets, controllers and scored steps."""

from pathlib import Path
import pickle
import random

import numpy as np

from .binding import file_digest
from .driver import StepResult
from .gym import GymBenchmark


def demo_directory(root, task, index):
    return Path(root) / task / "all_variations" / "episodes" / ("episode" + str(index))


class RLBenchBenchmark(GymBenchmark):
    def __init__(self, reference, task):
        super().__init__(reference, task)
        self.rvt = reference["environment"].get("protocol") == "rvt-test"
        self.cameras = reference["environment"]["cameras"]
        self.action_size = 9 if self.rvt else 8
        self.planning_error = None

    def reset(self, sample):
        from pyrep.const import RenderMode
        from rlbench.action_modes.action_mode import MoveArmThenGripper
        from rlbench.action_modes.arm_action_modes import JointVelocity
        from rlbench.action_modes.gripper_action_modes import Discrete
        from rlbench.environment import Environment
        from rlbench.observation_config import ObservationConfig
        from rlbench.utils import name_to_task_class

        seed = self.reset_seed(sample)
        np.random.seed(seed)
        random.seed(seed)
        arm_mode = JointVelocity
        if self.rvt:
            from rvt.utils.rlbench_planning import EndEffectorPoseViaPlanning2
            arm_mode = EndEffectorPoseViaPlanning2
        obs_config = ObservationConfig()
        obs_config.set_all(False)
        size = self.reference["parameters"]["renderSize"]
        for name in self.cameras:
            camera = getattr(obs_config, name + "_camera")
            camera.rgb = True
            camera.image_size = (size, size)
            if self.rvt:
                camera.point_cloud = True
                camera.render_mode = RenderMode.OPENGL
        obs_config.joint_positions = not self.rvt
        obs_config.gripper_pose = obs_config.gripper_open = True
        obs_config.gripper_joint_positions = self.rvt
        self.env = Environment(action_mode=MoveArmThenGripper(arm_mode(), Discrete()),
                               obs_config=obs_config, headless=True)
        self.env.launch()
        self.task_env = self.env.get_task(name_to_task_class(self.task))
        self.success, self.steps = False, 0
        self.planning_error = None
        if self.rvt:
            descriptions, raw = self.task_env.reset_to_demo(self.load_demo(int(sample["initialStateId"])))
        else:
            self.variation = int(self.task_env.sample_variation())
            descriptions, raw = self.task_env.reset()
        self.instruction = descriptions[0]
        self.previous_observation = self.observation(raw)
        return self.previous_observation

    def load_demo(self, index):
        config = self.reference["environment"]
        directory = demo_directory(config["assets"]["target"], self.task, index)
        contents = {}
        for name, expected in config["demoFiles"][self.task][index].items():
            path = directory / name
            if file_digest(path) != expected:
                raise ValueError("RLBench test episode differs from the frozen demo")
            contents[name] = path
        # The pinned upstream dataset serializes native Demo objects and the variation in pickle.
        with contents["variation_number.pkl"].open("rb") as stream:
            self.variation = pickle.load(stream)
        with contents["low_dim_obs.pkl"].open("rb") as stream:
            demo = pickle.load(stream)
        self.task_env.set_variation(self.variation)
        return demo

    def observation(self, raw):
        fields = {camera + "_rgb": np.asarray(getattr(raw, camera + "_rgb"), dtype=np.uint8)
                  for camera in self.cameras}
        if self.rvt:
            fields.update({camera + "_points": np.asarray(getattr(raw, camera + "_point_cloud"), dtype=np.float32)
                           for camera in self.cameras})
            fields["state.gripper_joints"] = np.clip(raw.gripper_joint_positions, 0, 0.04).astype(np.float32)
            fields["state.time"] = np.array([(1.0 - self.steps / (self.horizon - 1)) * 2.0 - 1.0], dtype=np.float32)
        else:
            fields["state.joints"] = np.asarray(raw.joint_positions, dtype=np.float32)
        fields["state.gripper_open"] = np.array([raw.gripper_open], dtype=np.float32)
        fields["state.ee_pose"] = np.asarray(raw.gripper_pose, dtype=np.float32)
        fields["instruction"] = self.instruction
        return fields

    def state(self, observation):
        return {**super().state(observation), "variation": self.variation}

    def step(self, action):
        from pyrep.errors import ConfigurationPathError, IKError
        from rlbench.backend.exceptions import InvalidActionError

        try:
            raw, reward, done = self.task_env.step(action)
            observation = self.observation(raw)
        except (ConfigurationPathError, IKError, InvalidActionError) as exc:
            if not self.rvt:
                raise
            # The RVT evaluator treats an unexecutable plan as a terminal policy failure.
            self.planning_error = type(exc).__name__
            observation, reward, done = self.previous_observation, 0, True
        self.steps += 1
        self.previous_observation = observation
        self.success = bool(reward >= 1)
        return StepResult(observation, float(self.success), bool(done or self.success or self.steps == self.horizon),
                          self.success)

    def result(self):
        return {"success": self.success, "source": "RLBench sparse task success", "task": self.task,
                **({"planningError": self.planning_error} if self.planning_error else {})}

    def close(self):
        if self.env is not None:
            self.env.shutdown()
            self.env = None
