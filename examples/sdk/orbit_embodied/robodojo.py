"""RoboDojo's native single-slot evaluator with Orbit-owned policy transport."""

from argparse import Namespace
import atexit
from functools import lru_cache
import importlib
import math
from pathlib import Path
from types import FunctionType

import numpy as np

from .assets import tree_digest
from .binding import file_digest, reference_horizon, robodojo_layout, seed_asset
from .driver import SampleRejected, StepResult
from .isaac import driver_version_kit_args


ROOT = Path("/workspace/RoboDojo")
JOINT_KEYS = ("left_arm_joint_state", "left_ee_joint_state", "right_arm_joint_state", "right_ee_joint_state")
CAMERAS = ("cam_head", "cam_left_wrist", "cam_right_wrist")
_APP = None


class OrbitPolicyLifecycle:
    """The common episode driver resets its independent policy after native reset."""

    def __init__(self, **_transport):
        self.resets = 0

    def call(self, *, func_name, **_arguments):
        if func_name != "reset":
            raise RuntimeError("policy calls must use Orbit's bound policy connector")
        self.resets += 1


def create_native_env(module, config, app):
    factory = module.create_eval_env
    namespace = {**factory.__globals__, "WsModelClient": OrbitPolicyLifecycle}
    delegated = FunctionType(factory.__code__, namespace, factory.__name__, factory.__defaults__, factory.__closure__)
    delegated.__kwdefaults__ = factory.__kwdefaults__
    return delegated(config, app)


@lru_cache(maxsize=1)
def check_runtime(source_files, assets_target, assets_digest):
    for relative, expected in source_files:
        if file_digest(ROOT / relative) != expected:
            raise ValueError("RoboDojo image source differs from the frozen reference: " + relative)
    if tree_digest(assets_target) != assets_digest:
        raise ValueError("RoboDojo assets differ from the frozen reference")


def simulation_app():
    global _APP
    if _APP is None:
        from src.eval_client.physx_warning_monitor import get_monitor
        from env.camera_manager.capture.render_sync import add_zero_delay_kit_args
        from isaaclab.app import AppLauncher

        # Capture fatal PhysX errors before Kit starts, including later tasks in a batch.
        get_monitor().start(enabled=True)
        arguments = Namespace(headless=True, enable_cameras=True, device="cuda:0", kit_args="")
        add_zero_delay_kit_args(arguments)
        arguments.kit_args = (arguments.kit_args + " " + driver_version_kit_args()).strip()
        _APP = AppLauncher(arguments).app
        atexit.register(_APP.close)
    return _APP


def native_config(task, eval_seed):
    from omegaconf import OmegaConf
    from task.RoboDojo.task_registry import task_config_path
    from utils.load_file import load_yaml
    from utils.pipeline_utils import process_config, process_randomization

    config_root = ROOT / "env_cfg"
    evaluation = load_yaml(str(config_root / "arx_x5.yml"))
    evaluation.update(task_name=task, num_envs=1, device_id=0, eval_batch=False,
                      policy_name="orbit-independent", additional_info="orbit", seed=eval_seed,
                      eval_num=1)
    config = OmegaConf.create({
        **{section: load_yaml(str(config_root / section / (name + ".yml")))
           for section, name in evaluation["config"].items()},
        "task_env": load_yaml(task_config_path(ROOT / "task/RoboDojo/config", task)),
        "eval_cfg": evaluation,
        "deploy_cfg": {"policy_name": "orbit-independent", "port": 1, "host": "unused"},
    })
    config.eval_cfg.physx_monitor_enabled = bool(config.task_env.get("Articulation"))
    config.sim.scene.num_envs = 1
    config = process_randomization(config)
    config, _ = process_config(config, task_name=task)
    config.camera.default_frequency = evaluation["observation"]["collect_freq"]
    config.sim.seed = [0]
    return config


def joint_action(action):
    values = np.asarray(action)
    if values.shape != (14,) or not np.isfinite(values).all():
        raise ValueError("RoboDojo requires 14 finite absolute joint/gripper targets")
    return {key: values[start:end].tolist() for key, start, end in
            zip(JOINT_KEYS, (0, 6, 7, 13), (6, 7, 13, 14))}


class RoboDojoBenchmark:
    action_size = 14
    settle_steps = 0

    def __init__(self, reference, task):
        environment = reference["environment"]
        if task not in environment["tasks"]:
            raise ValueError("task is outside the frozen RoboDojo catalog")
        if task in environment.get("unsupported", {}):
            raise ValueError(environment["unsupported"][task])
        self.reference, self.task = reference, task
        self.horizon = reference_horizon(reference, task)
        self.env, self.video = None, None
        self.layout = None

    def reset(self, sample):
        if sample["taskId"] != self.task or sample["initialStateDigest"] != seed_asset(self.reference, self.task):
            raise ValueError("RoboDojo layout plan differs from the frozen sample")
        entry = robodojo_layout(self.reference, self.task, sample["environmentSeed"], int(sample["initialStateId"]))
        self.layout = {"evalSeed": sample["environmentSeed"], **entry}
        assets = self.reference["environment"]["assets"]
        check_runtime(tuple(sorted(self.reference["reference"]["files"].items())), assets["target"], assets["digest"])
        app = simulation_app()
        native = importlib.import_module("src.eval_client.eval_env")
        from src.eval_client.physx_warning_monitor import get_monitor
        from utils.cluttered_generator import UnStableError

        get_monitor().reset()
        self.env = create_native_env(native, native_config(self.task, sample["environmentSeed"]), app)
        if self.env.step_lim != self.horizon:
            raise ValueError("native RoboDojo horizon differs from the frozen task")
        actual = Path(self.env.seed_manager.seed_info[entry["id"]]["scene_layout"]).resolve()
        if actual.relative_to(Path(assets["target"]).resolve()).as_posix() != entry["file"] or file_digest(actual) != entry["digest"]:
            raise ValueError("native RoboDojo selected a different layout")
        try:
            self.env.reset(seed=[entry["id"]])
        except UnStableError as exc:
            raise SampleRejected(str(exc)) from exc
        self.env.run_reward()
        if hasattr(self.env, "get_score"):
            self.env.get_score()
        if getattr(self.env, "interact", False) and hasattr(self.env, "query_support_arm_traj"):
            self.env.query_support_arm_traj(env_idx=0)
        return self.observation(self.env.get_obs())

    def observation(self, raw):
        state = raw["state"]
        return {
            **{name: raw["vision"][name]["color"] for name in CAMERAS},
            "joint_state": np.concatenate([state[key] for key in JOINT_KEYS]).astype(np.float32),
            "native_action_state": np.concatenate([raw["action"][key] for key in JOINT_KEYS]).astype(np.float32),
            "left_ee_pose": np.asarray(state["left_ee_pose"], dtype=np.float32),
            "right_ee_pose": np.asarray(state["right_ee_pose"], dtype=np.float32),
            "instruction": raw["instruction"],
        }

    def native_state(self):
        ended = bool(self.env.end_flag[0])
        process = float(self.env.reward_manager.get_score()[0]) if hasattr(self.env, "get_score") else None
        if process is not None and (not math.isfinite(process) or not 0 <= process <= 100):
            raise ValueError("native RoboDojo process score is outside [0, 100]")
        return {"layout": self.layout, "nativeStepCount": int(self.env.take_action_cnt[0]),
                "nativeEnded": ended, "nativeSuccess": ended and bool(self.env.success[0]),
                "nativeUnstable": 0 in self.env.unstable_envs, "processScore": process}

    def step(self, action):
        if self.env.end_flag[0]:
            raise RuntimeError("RoboDojo episode has already ended")
        before = self.env.take_action_cnt[0]
        self.env.take_action(joint_action(action))
        if 0 in self.env.unstable_envs:
            raise SampleRejected("native RoboDojo rejected the frozen layout during control")
        if self.env.take_action_cnt[0] != before + 1:
            raise ValueError("native RoboDojo did not execute exactly one control action")
        status = self.native_state()
        return StepResult(self.observation(self.env.get_obs()), float(status["nativeSuccess"]),
                          status["nativeEnded"], status["nativeSuccess"], native_action=np.asarray(action).tolist())

    def state(self, observation):
        return {**self.native_state(), "joint_state": observation["joint_state"].tolist(),
                "left_ee_pose": observation["left_ee_pose"].tolist(),
                "right_ee_pose": observation["right_ee_pose"].tolist(), "instruction": observation["instruction"]}

    def result(self):
        status = self.native_state()
        if not status["nativeEnded"] or status["nativeUnstable"]:
            raise ValueError("RoboDojo has no valid terminal native result")
        score = 1.0 if status["nativeSuccess"] else (status["processScore"] or 0.0) / 100
        return {**status, "success": status["nativeSuccess"], "score": score,
                "source": "RoboDojo native RewardManager and EvalEnv termination"}

    def start_video(self, directory):
        import imageio
        self.video = imageio.get_writer(str(Path(directory) / "video.mp4"), fps=25)

    def record_frame(self, observation):
        self.video.append_data(observation["cam_head"])

    def finish_video(self):
        if self.video is not None:
            self.video.close()
            self.video = None

    def close(self):
        if self.env is not None:
            self.env.close()
            self.env = None
