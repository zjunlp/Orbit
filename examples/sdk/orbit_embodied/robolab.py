"""Pinned RoboLab joint-position episodes; Isaac starts only in the solve process."""

import atexit
from importlib.metadata import version
from pathlib import Path
import tempfile

import numpy as np

from .assets import tree_digest
from .binding import digest, file_digest, reference_horizon, reset_seed, seed_asset
from .driver import StepResult
from .isaac import driver_version_kit_args


_APP = None


def simulation_app():
    global _APP
    if _APP is None:
        import cv2  # noqa: F401
        from isaaclab.app import AppLauncher
        _APP = AppLauncher(headless=True, enable_cameras=True, device="cuda:0",
                           kit_args=driver_version_kit_args())
        atexit.register(_APP.app.close)
    return _APP.app


def check_assets(root, expected=None):
    root = Path(root)
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError("RoboLab assets must be regular files")
        if path.is_file():
            with path.open("rb") as stream:
                if stream.read(64).startswith(b"version https://git-lfs.github.com/spec/v1"):
                    raise ValueError("RoboLab asset is a Git LFS pointer: " + path.relative_to(root).as_posix())
    actual = tree_digest(root)
    if expected is not None and actual != expected:
        raise ValueError("RoboLab asset digest mismatch")
    return actual


def isaaclab_source_digest(root):
    root = Path(root)
    files = ["VERSION", "source/isaaclab/config/extension.toml",
             *sorted(path.relative_to(root).as_posix()
                     for path in (root / "source/isaaclab").rglob("*.py")),
             *sorted(path.relative_to(root).as_posix() for path in (root / "apps").rglob("*")
                     if path.is_file() and path.suffix in (".kit", ".toml"))]
    return digest([{"path": name, "digest": file_digest(root / name)} for name in files])


def check_runtime(reference):
    config = reference["environment"]
    root = Path(config["sourceRoot"])
    for relative, expected in reference["reference"]["files"].items():
        if file_digest(root / relative) != expected:
            raise ValueError("RoboLab runtime source differs: " + relative)
    assets = config["assets"]
    if Path(assets["target"]) != root / "assets":
        raise ValueError("RoboLab assets must occupy the native source-relative asset directory")
    check_assets(assets["target"], assets["digest"])
    if version("isaaclab") != config["isaacLabPackageVersion"]:
        raise ValueError("Isaac Lab differs from the frozen RoboLab stack")
    lab_source = config["isaacLabSource"]
    if isaaclab_source_digest(lab_source["root"]) != lab_source["digest"]:
        raise ValueError("Isaac Lab source differs from the frozen official container")
    sim_version = Path(config["isaacSimVersionFile"]).read_text().strip()
    if sim_version.split("-")[0] != config["isaacSim"]:
        raise ValueError("Isaac Sim differs from the frozen RoboLab stack")


def array(value):
    if hasattr(value, "detach"):
        value = value.detach().cpu().numpy()
    return np.array(value, copy=True)


class RoboLabBenchmark:
    def __init__(self, reference, task):
        self.reference, self.task = reference, task
        self.config = reference["environment"]
        if task not in self.config["tasks"]:
            raise ValueError("task is outside the frozen RoboLab catalog")
        self.horizon = reference_horizon(reference, task)
        self.action_size = 8
        self.settle_steps = 0
        self.env, self.video, self.directory = None, None, None
        self.steps, self.native_result = 0, None
        self.reset_actions = []
        self._temporary = None

    def make_env(self, seed):
        check_runtime(self.reference)
        simulation_app()
        from robolab.constants import set_output_dir
        from robolab.core.environments.runtime import create_env
        from robolab.registrations.droid.auto_env_registrations_jointpos import auto_register_droid_envs

        if self.directory is None:
            self._temporary = tempfile.TemporaryDirectory(prefix="orbit-robolab-")
            self.directory = Path(self._temporary.name)
        set_output_dir(str(self.directory / "native"))
        auto_register_droid_envs(task_dirs=["benchmark"], task=self.task)
        env, cfg = create_env(self.task, seed=seed, num_envs=1, device="cuda:0",
                              instruction_type="default", renderer="realtime")
        try:
            if (env.num_envs != 1 or env.action_manager.total_action_dim != self.action_size
                    or env.max_episode_length != self.horizon
                    or not np.isclose(cfg.sim.dt * cfg.decimation, 1 / self.config["controlHz"])
                    or cfg.instruction != {"default": self.config["instructions"][self.task]}):
                raise ValueError("RoboLab native control limits or instruction differ from the frozen recipe")
            return env
        except Exception:
            env.close()
            raise

    def reset(self, sample):
        if (sample["taskId"] != self.task
                or sample["initialStateDigest"] != seed_asset(self.reference, self.task)):
            raise ValueError("RoboLab reset differs from the frozen sample")
        self.env = self.make_env(reset_seed(sample, self.reference))
        self.env.reset()
        raw, _ = self.env.reset()
        self.steps, self.native_result = 0, None
        return self.observation(raw)

    def observation(self, raw):
        return {
            "front_rgb": array(raw["image_obs"]["over_shoulder_left_camera"][0]),
            "wrist_rgb": array(raw["image_obs"]["wrist_cam"][0]),
            "joint_position": array(raw["proprio_obs"]["arm_joint_pos"][0]).astype(np.float32),
            "gripper_position": array(raw["proprio_obs"]["gripper_pos"][0]).astype(np.float32),
            "instruction": self.config["instructions"][self.task],
        }

    def step(self, action):
        import torch
        action = np.asarray(action, dtype=np.float32)
        if action.shape != (self.action_size,) or not np.isfinite(action).all():
            raise ValueError("RoboLab requires eight finite absolute joint/gripper targets")
        raw, reward, _terminated, _truncated, _info = self.env.step(
            torch.as_tensor(action, device=self.env.device).unsqueeze(0))
        self.steps += 1
        results = self.env.get_env_results()
        if len(results) != 1 or results[0]["env_id"] != 0:
            raise ValueError("RoboLab returned an unexpected native environment result")
        self.native_result = dict(results[0])
        done = bool(self.env.all_terminated)
        success = self.native_result["success"]
        # Early physics artifacts set the Gym flags but do not freeze a native result.
        if done != (type(success) is bool):
            raise ValueError("RoboLab frozen termination and native result disagree")
        return StepResult(self.observation(raw), float(array(reward).reshape(-1)[0]), done,
                          success is True, simulation_time=self.steps / self.config["controlHz"],
                          native_action=action.tolist())

    def result(self):
        if self.native_result is None or type(self.native_result["success"]) is not bool:
            raise ValueError("RoboLab reached the control horizon without a native terminal result")
        return {"success": self.native_result["success"], "source": "RobolabEnv.get_env_results",
                "task": self.task, "native": self.native_result}

    @staticmethod
    def state(observation):
        return {field: observation[field].tolist() for field in ("joint_position", "gripper_position")}

    def start_video(self, directory):
        self.directory = Path(directory)
        import imageio
        self.video = imageio.get_writer(str(self.directory / "video.mp4"), fps=self.config["controlHz"])

    def record_frame(self, observation):
        self.video.append_data(observation["front_rgb"])

    def finish_video(self):
        if self.video is not None:
            self.video.close()
            self.video = None

    def finalize_evidence(self):
        if self.env is not None:
            # The pinned RecorderManager exposes no close; its destructor closes these two handlers.
            recorder = self.env.recorder_manager
            for name in ("_dataset_file_handler", "_failed_episode_dataset_file_handler"):
                handler = getattr(recorder, name)
                if handler is not None:
                    handler.close()

    def close(self):
        try:
            if self.env is not None:
                self.env.close()
                self.env = None
        finally:
            if self._temporary is not None:
                self._temporary.cleanup()
                self._temporary = None
