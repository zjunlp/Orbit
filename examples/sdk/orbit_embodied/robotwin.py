"""Native RoboTwin 2.0 episodes with the upstream expert feasibility check."""

from functools import lru_cache
import importlib
from pathlib import Path
import random

import numpy as np

from .assets import tree_digest
from .binding import reference_horizon, seed_asset
from .driver import SampleRejected, StepResult


@lru_cache(maxsize=1)
def check_assets(target, expected):
    if tree_digest(target) != expected:
        raise ValueError("RoboTwin assets differ from the frozen reference")


def native_args(root, task, suite):
    import yaml

    def read(path):
        return yaml.safe_load((root / path).read_text(encoding="utf-8"))

    args = read(f"task_config/{suite}.yml")
    if args["embodiment"] != ["aloha-agilex"]:
        raise ValueError("expected the RoboTwin Aloha-AgileX embodiment")
    embodiment = read("task_config/_embodiment_config.yml")["aloha-agilex"]
    robot = Path(embodiment["file_path"])
    camera = read("task_config/_camera_config.yml")[args["camera"]["head_camera_type"]]
    return {
        **args, "task_name": task, "task_config": suite, "eval_mode": True,
        "render_freq": 0, "eval_video_log": False,
        "dual_arm_embodied": True,
        "left_robot_file": str(robot), "right_robot_file": str(robot),
        "left_embodiment_config": read(robot / "config.yml"),
        "right_embodiment_config": read(robot / "config.yml"),
        "head_camera_h": camera["h"], "head_camera_w": camera["w"],
    }


class RoboTwinBenchmark:
    action_size = 14
    settle_steps = 0

    def __init__(self, reference, task):
        self.reference, self.task = reference, task
        if task not in reference["environment"]["tasks"]:
            raise ValueError("task is not in the frozen RoboTwin catalog")
        self.horizon = reference_horizon(reference, task)
        self.env = None
        self.video = None

    def reset(self, sample):
        if sample["taskId"] != self.task or sample["initialStateDigest"] != seed_asset(self.reference, self.task):
            raise ValueError("RoboTwin reset recipe differs from the frozen sample")
        self.seed = sample["environmentSeed"] + int(sample["initialStateId"])
        if not 0 <= self.seed < 2 ** 32:
            raise ValueError("RoboTwin seed must fit in an unsigned 32-bit integer")
        config = self.reference["environment"]
        assets = config["assets"]
        check_assets(assets["target"], assets["digest"])
        args = native_args(Path(assets["target"]).parent, self.task, config["suite"])
        native = importlib.import_module("envs." + self.task)
        from envs.utils.create_actor import UnStableError
        from generate_episode_instructions import generate_episode_descriptions

        self.env = getattr(native, self.task)()
        try:
            self.env.setup_demo(now_ep_num=0, seed=self.seed, is_test=True, **args)
            info = self.env.play_once()["info"]
        except UnStableError as exc:
            self.close()
            raise SampleRejected(str(exc)) from exc
        self.env.close_env()
        if not (self.env.plan_success and self.env.check_success()):
            self.env = None
            raise SampleRejected("frozen RoboTwin seed did not pass the native expert check")

        self.env.setup_demo(now_ep_num=0, seed=self.seed, is_test=True, **args)
        if self.env.step_lim != self.horizon:
            raise ValueError("native RoboTwin control limit differs from the frozen recipe")
        random_state = random.getstate()
        try:
            random.seed(self.seed)
            descriptions = generate_episode_descriptions(self.task, [info], config["instructionCount"])
            self.instruction = str(np.random.choice(descriptions[0][config["instructionSplit"]]))
        finally:
            random.setstate(random_state)
        self.env.set_instruction(instruction=self.instruction)
        return self.observation(self.env.get_obs())

    def observation(self, raw):
        return {
            **{name: raw["observation"][name]["rgb"] for name in ("head_camera", "left_camera", "right_camera")},
            "joint_state": raw["joint_action"]["vector"],
            "instruction": self.env.get_instruction(),
        }

    @staticmethod
    def state(observation):
        return {"joint_state": observation["joint_state"].tolist(), "instruction": observation["instruction"]}

    def step(self, action):
        previous = self.env.take_action_cnt
        self.env.take_action(action, action_type="qpos")
        if self.env.take_action_cnt != previous + 1:
            raise ValueError("native RoboTwin controller did not execute the requested action")
        success = bool(self.env.eval_success)
        return StepResult(self.observation(self.env.get_obs()), float(success),
                          success or self.env.take_action_cnt == self.horizon, success,
                          native_action=action.tolist())

    def result(self):
        success = bool(self.env.eval_success)
        return {"source": "RoboTwin eval_success", "task": self.task, "seed": self.seed,
                "success": success, "termination": "success" if success else "horizon"}

    def start_video(self, directory):
        import imageio
        self.video = imageio.get_writer(str(directory / "video.mp4"), fps=10)

    def record_frame(self, observation):
        self.video.append_data(observation["head_camera"])

    def finish_video(self):
        if self.video is not None:
            self.video.close()
            self.video = None

    def close(self):
        if self.env is not None:
            self.env.close_env()
            self.env = None
