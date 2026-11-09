"""Native RoboTwin 2.0 episodes with the upstream expert feasibility check."""

from contextlib import ExitStack
from functools import lru_cache
import importlib
from pathlib import Path
import random
from traceback import walk_tb

import numpy as np

from .assets import tree_digest
from .binding import reference_horizon, seed_asset
from .driver import SampleRejected, StepResult


CAMERA_VIDEOS = {
    "head_camera": "video.mp4",
    "left_camera": "left-camera.mp4",
    "right_camera": "right-camera.mp4",
}
VIDEO_FPS = 10


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


def setup_native_scene(env, seed, args):
    setup = {**args, "now_ep_num": 0, "seed": seed, "is_test": True}
    if not args["domain_randomization"]["cluttered_table"]:
        env.setup_demo(**setup)
        return
    # The upstream method adds table bias in place. Pass fresh native bounds on every reset.
    add_clutter = env.get_cluttered_table
    env.get_cluttered_table = lambda: add_clutter(xlim=[-0.59, 0.59], ylim=[-0.34, 0.34])
    try:
        env.setup_demo(**setup)
    finally:
        del env.get_cluttered_table


class RoboTwinBenchmark:
    action_size = 14
    action_type = "qpos"
    settle_steps = 0

    def __init__(self, reference, task):
        self.reference, self.task = reference, task
        if task not in reference["environment"]["tasks"]:
            raise ValueError("task is not in the frozen RoboTwin catalog")
        self.horizon = reference_horizon(reference, task)
        self.env = None
        self.video_stack = ExitStack()
        self.videos = {}

    def _native_args(self):
        config = self.reference["environment"]
        assets = config["assets"]
        check_assets(assets["target"], assets["digest"])
        return native_args(Path(assets["target"]).parent, self.task, config["suite"])

    def _expert_scene(self, seed, args):
        native = importlib.import_module("envs." + self.task)
        from envs.utils.create_actor import UnStableError

        env = getattr(native, self.task)()
        try:
            setup_native_scene(env, seed, args)
            episode = env.play_once()
        except UnStableError as exc:
            raise SampleRejected(str(exc)) from exc
        except AssertionError as exc:
            # The pinned expert constructs a move even when grasp planning finds no pose.
            if str(exc) != "target_pose cannot be None for move action.":
                raise
            frames = [(frame.f_globals.get("__name__"), frame.f_code.co_name)
                      for frame, _ in walk_tb(exc.__traceback__)]
            if frames[-2:] != [("envs._base_task", "grasp_actor"), ("envs.utils.action", "__init__")]:
                raise
            raise SampleRejected("native RoboTwin expert found no reachable grasp pose") from exc
        finally:
            env.close_env()
        if not (env.plan_success and env.check_success()):
            raise SampleRejected("frozen RoboTwin seed did not pass the native expert check")
        return env, episode["info"]

    def expert_accepts(self, seed, candidate_index):
        args = self._native_args()
        try:
            self._expert_scene(seed, args)
        except SampleRejected:
            return False
        finally:
            if (candidate_index + 1) % args["clear_cache_freq"] == 0:
                from sapien.render import clear_cache
                clear_cache()
        return True

    def reset(self, sample):
        if sample["taskId"] != self.task or sample["initialStateDigest"] != seed_asset(self.reference, self.task):
            raise ValueError("RoboTwin reset recipe differs from the frozen sample")
        self.seed = sample["environmentSeed"] + int(sample["initialStateId"])
        if not 0 <= self.seed < 2 ** 32:
            raise ValueError("RoboTwin seed must fit in an unsigned 32-bit integer")
        config = self.reference["environment"]
        args = self._native_args()
        self.env, info = self._expert_scene(self.seed, args)
        setup_native_scene(self.env, self.seed, args)
        native_limits = config.get("nativeHorizons", {})
        if self.env.step_lim != native_limits.get(self.task, self.horizon):
            raise ValueError("native RoboTwin control limit differs from the frozen recipe")
        self.instruction = self._instruction(info)
        self.env.set_instruction(instruction=self.instruction)
        return self.observation(self.env.get_obs())

    def _instruction(self, info):
        config = self.reference["environment"]
        if config.get("instructionMode") == "task-name":
            return self.task.replace("_", " ")

        from generate_episode_instructions import generate_episode_descriptions

        random_state = random.getstate()
        try:
            random.seed(self.seed)
            descriptions = generate_episode_descriptions(self.task, [info], config["instructionCount"])
            return str(np.random.choice(descriptions[0][config["instructionSplit"]]))
        finally:
            random.setstate(random_state)

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
        self.env.take_action(action, action_type=self.action_type)
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

        with ExitStack() as stack:
            self.videos = {
                camera: stack.enter_context(imageio.get_writer(str(directory / name), fps=VIDEO_FPS))
                for camera, name in CAMERA_VIDEOS.items()
            }
            self.video_stack = stack.pop_all()

    def record_frame(self, observation):
        for camera, writer in self.videos.items():
            writer.append_data(observation[camera])

    def finish_video(self):
        self.video_stack.close()
        self.videos.clear()

    def close(self):
        if self.env is not None:
            self.env.close_env()
            self.env = None


class RoboTwinCartesianBenchmark(RoboTwinBenchmark):
    action_size = 16
    action_type = "ee"

    def reset(self, sample):
        self.target = None
        observation = super().reset(sample)
        self.env.actor_pose = True
        return observation

    def observation(self, raw):
        native = super().observation(raw)
        pose = raw["endpose"]
        # The X-VLA reference conditions on the last commanded poses and live grippers.
        left, right = self.target if self.target is not None else (pose["left_endpose"], pose["right_endpose"])
        native["ee_state"] = np.r_[left, pose["left_gripper"], right, pose["right_gripper"]].astype(np.float64)
        return native

    def step(self, action):
        self.target = (action[:7], action[8:15])
        step = super().step(action)
        step.terminated = step.terminated or not self.env.actor_pose
        return step

    def result(self):
        verdict = super().result()
        if not self.env.actor_pose and not verdict["success"]:
            verdict["termination"] = "actor_pose"
        return verdict
