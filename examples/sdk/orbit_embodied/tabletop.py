"""Native Gymnasium episodes for the pinned ManiSkill3 and Meta-World recipes."""

from pathlib import Path

import numpy as np

from .binding import reference_horizon, reset_seed, seed_asset
from .assets import tree_digest
from .driver import StepResult


class TabletopBenchmark:
    def __init__(self, reference, task):
        self.reference, self.task = reference, task
        self.config = reference["environment"]
        if task not in self.config["tasks"]:
            raise ValueError("task is outside the frozen native catalog")
        self.action_size = reference["benchmarkProfile"]["action"]["shape"][0]
        self.horizon = reference_horizon(reference, task)
        self.settle_steps = reference["parameters"]["settleSteps"]
        self.env, self.video = None, None
        self.success = False
        self.reset_actions = []

    def reset(self, sample):
        if sample["taskId"] != self.task or sample["initialStateDigest"] != seed_asset(self.reference, self.task):
            raise ValueError("native reset differs from the frozen sample")
        seed = reset_seed(sample, self.reference)
        self.env = self.make_env(seed)
        raw, _ = self.env.reset(seed=seed)
        for step in range(self.settle_steps):
            action = np.zeros(self.action_size, dtype=np.float32)
            raw, reward, terminated, _, _ = self.env.step(action)
            self.reset_actions.append({"phase": "settle", "step": step, "action": action.tolist(),
                                       "reward": float(reward), "terminated": bool(terminated)})
        return self.observation(raw)

    def step(self, action):
        raw, reward, terminated, truncated, info = self.env.step(np.asarray(action, dtype=np.float32))
        self.success = bool(info["success"])
        return StepResult(self.observation(raw), float(reward), bool(terminated or truncated or self.success),
                          self.success)

    def result(self):
        return {"success": self.success, "source": "native Gymnasium info.success", "task": self.task}

    @staticmethod
    def state(observation):
        return {"state": observation["state"].tolist()} if "state" in observation else {}

    def start_video(self, directory):
        import imageio
        self.video = imageio.get_writer(str(Path(directory) / "video.mp4"), fps=self.config["controlHz"])

    def record_frame(self, observation):
        self.video.append_data(observation["front_rgb"])

    def finish_video(self):
        if self.video is not None:
            self.video.close()
            self.video = None

    def close(self):
        if self.env is not None:
            self.env.close()


def check_maniskill_assets(target, expected):
    if tree_digest(target) != expected:
        raise ValueError("ManiSkill task asset digest mismatch")


class ManiSkillBenchmark(TabletopBenchmark):
    def make_env(self, _seed):
        import gymnasium as gym
        import orbit_maniskill_task  # noqa: F401
        assets = self.config["assets"]
        check_maniskill_assets(assets["target"], assets["digest"])
        return gym.make(self.task, num_envs=1, obs_mode="rgb+segmentation",
                        control_mode="arm_pd_ee_target_delta_pose_align2_gripper_pd_joint_pos",
                        sim_backend="gpu", sim_config={"sim_freq": 500, "control_freq": 5},
                        sensor_configs={"shader_pack": "default"}, render_mode="all",
                        obj_set="train", use_multiple_plates=False)

    def observation(self, raw):
        return {"front_rgb": raw["sensor_data"]["3rd_view_camera"]["rgb"][0].cpu().numpy(),
                "instruction": self.env.unwrapped.get_language_instruction()[0]}


class MetaWorldBenchmark(TabletopBenchmark):
    def make_env(self, seed):
        import gymnasium as gym
        import metaworld  # noqa: F401

        height, width, _ = self.reference["benchmarkProfile"]["observations"]["front_rgb"]["shape"]
        # MT1 generates its goal catalog before the first reset.
        env = gym.make("Meta-World/MT1", env_name=self.task, seed=seed, render_mode="rgb_array", camera_id=2,
                       width=width, height=height, disable_env_checker=True)
        env.unwrapped.model.cam_pos[2] = [0.75, 0.075, 0.7]
        return env

    def observation(self, raw):
        return {"front_rgb": np.ascontiguousarray(self.env.render()[::-1, ::-1]),
                "state": np.asarray(raw[:4], dtype=np.float32),
                "instruction": self.config["instructions"][self.task]}


class ManiSkillTabletopBenchmark(TabletopBenchmark):
    def make_env(self, _seed):
        import gymnasium as gym
        import mani_skill.envs  # noqa: F401
        from importlib.metadata import version
        from mani_skill.utils.assets import DATA_GROUPS, is_data_source_downloaded
        from mani_skill.utils.registration import REGISTERED_ENVS
        from mani_skill.utils.wrappers.flatten import FlattenActionSpaceWrapper

        if version("mani_skill") != self.config["version"]:
            raise ValueError("ManiSkill package differs from the frozen tabletop recipe")
        assets = self.config.get("assets")
        if assets:
            check_maniskill_assets(assets["target"], assets["digest"])
            asset_source = self.config["assetSource"]
            if not all(is_data_source_downloaded(key) for key in DATA_GROUPS.get(asset_source, (asset_source,))):
                raise ValueError("ManiSkill asset source is incomplete: " + asset_source)
        profile = self.reference["benchmarkProfile"]
        height, width, _ = profile["observations"]["front_rgb"]["shape"]
        env = gym.make(self.task, num_envs=1, obs_mode="rgb", reward_mode="sparse",
                       control_mode=profile["action"]["controller"], sim_backend="cpu",
                       sensor_configs={"width": width, "height": height}, disable_env_checker=True)
        try:
            native = env.unwrapped
            robot = native.robot_uids
            if isinstance(robot, tuple):
                robot = list(robot)
            if (robot != self.config["robot"] or REGISTERED_ENVS[self.task].max_episode_steps != self.horizon
                    or native.control_freq != self.config["controlHz"]):
                raise ValueError("ManiSkill robot or control limits differ from the frozen tabletop recipe")
            if isinstance(native.single_action_space, gym.spaces.Dict):
                env = FlattenActionSpaceWrapper(env)
            space = env.action_space
            if space.shape != (self.action_size,) or not (np.all(space.low == -1) and np.all(space.high == 1)):
                raise ValueError("ManiSkill action shape or bounds differ from the frozen tabletop recipe")
            return env
        except Exception:
            env.close()
            raise

    def observation(self, raw):
        fields = self.reference["benchmarkProfile"]["observations"]
        observation = {name: raw["sensor_data"][field["camera"]]["rgb"][0].cpu().numpy()
                       for name, field in fields.items() if field["semantic"] == "rgb"}
        observation["instruction"] = self.config["instructions"][self.task]
        source = self.config.get("goalPosition")
        if source == "extra.goal_pos":
            goal = raw["extra"]["goal_pos"]
        elif source == "goal_site":
            # TwoRobotPickCube hides its goal marker and omits the target from RGB extras.
            goal = self.env.unwrapped.goal_site.pose.p
        elif source is None:
            return observation
        else:
            raise ValueError("unknown ManiSkill tabletop goal position source")
        observation["goal_pos"] = goal[0].cpu().numpy().copy()
        return observation

    @staticmethod
    def state(observation):
        return {"goal_pos": observation["goal_pos"].tolist()} if "goal_pos" in observation else {}
