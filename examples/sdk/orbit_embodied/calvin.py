"""Native CALVIN rollouts with one control interval per language subtask."""

from pathlib import Path

import numpy as np

from .binding import reference_horizon, reset_seed, seed_asset
from .driver import StepResult


def sequence_for(reference, sample):
    catalog = reference["environment"]["catalog"]
    state_index, tasks = catalog["sequences"][reset_seed(sample, reference)]
    return catalog["states"][state_index], tasks


class CalvinBenchmark:
    action_size = 7
    settle_steps = 0

    def __init__(self, reference, task):
        if task not in reference["environment"]["tasks"]:
            raise ValueError("task is outside the frozen CALVIN catalog")
        self.reference, self.task = reference, task
        self.horizon = reference_horizon(reference, task)
        self.limit = reference["parameters"]["subtaskSteps"]
        self.instructions = reference["environment"]["catalog"]["instructions"]
        self.env, self.video = None, None

    def reset(self, sample):
        import hydra
        from calvin_env.envs.play_table_env import get_env
        from omegaconf import OmegaConf

        if sample["taskId"] != self.task or sample["initialStateDigest"] != seed_asset(self.reference, self.task):
            raise ValueError("CALVIN reset differs from the frozen sequence plan")
        (robot, scene), self.sequence = sequence_for(self.reference, sample)
        root = Path("/opt/calvin")
        self.env = get_env(root / "scene", show_gui=False)
        self.oracle = hydra.utils.instantiate(OmegaConf.load(
            root / "agent/conf/callbacks/rollout/tasks/new_playtable_tasks.yaml"))
        self.completed, self.subtask_steps = 0, 0
        raw = self.env.reset(robot_obs=np.asarray(robot), scene_obs=np.asarray(scene))
        self.initial = self.env.get_info()
        return self.observation(raw)

    def observation(self, raw):
        task = self.sequence[min(self.completed, len(self.sequence) - 1)]
        return {"front_rgb": raw["rgb_obs"]["rgb_static"], "wrist_rgb": raw["rgb_obs"]["rgb_gripper"],
                "state": np.asarray(raw["robot_obs"][:7], dtype=np.float32),
                "instruction": self.instructions[task]}

    def step(self, action):
        raw, _, _, info = self.env.step(np.asarray(action, dtype=np.float32))
        self.subtask_steps += 1
        completed = bool(self.oracle.get_task_info_for_set(self.initial, info, {self.sequence[self.completed]}))
        if completed:
            self.completed += 1
            self.initial, self.subtask_steps = info, 0
        success = self.completed == len(self.sequence)
        return StepResult(self.observation(raw), float(completed), success or self.subtask_steps == self.limit,
                          success, replan=completed)

    def state(self, observation):
        return {"state": observation["state"].tolist(), "completedSubtasks": self.completed,
                "instruction": observation["instruction"]}

    def result(self):
        return {"success": self.completed == len(self.sequence), "source": "CALVIN native task oracle",
                "sequence": self.sequence, "completedSubtasks": self.completed}

    def start_video(self, directory):
        import imageio

        self.video = imageio.get_writer(str(Path(directory) / "video.mp4"), fps=30)

    def record_frame(self, observation):
        self.video.append_data(observation["front_rgb"])

    def finish_video(self):
        if self.video is not None:
            self.video.close()

    def close(self):
        if self.env is not None:
            self.env.close()
            self.env.cid = -1
            self.env = None
