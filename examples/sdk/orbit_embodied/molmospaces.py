"""Native MolmoSpaces MS manipulation evaluation with fixed JSON episodes."""

import json
import os
from functools import lru_cache, partial
from pathlib import Path
import tempfile

import numpy as np

from .binding import file_digest
from .driver import StepResult
from .gym import GymBenchmark


@lru_cache(maxsize=1)
def load_catalog(path, checksum):
    if file_digest(path) != checksum:
        raise ValueError("MolmoSpaces episode catalog differs from the frozen reference")
    return json.loads(path.read_text())


@lru_cache(maxsize=1)
def offline_assets(root):
    """Use the pinned cache read-only and keep the upstream runtime indices in scratch."""
    mounted = Path(root)
    scratch = tempfile.TemporaryDirectory(prefix="orbit-molmospaces-")
    local = Path(scratch.name)
    for entry in (mounted / "assets").iterdir():
        if entry.name != ".lmdb":
            (local / entry.name).symlink_to(entry)
    os.environ["MLSPACES_ASSETS_DIR"] = scratch.name
    os.environ["MLSPACES_CACHE_DIR"] = str(mounted / "cache")
    os.environ["MLSPACES_CACHE_LOCK"] = "False"
    from molmo_spaces import molmo_spaces_constants

    installed = json.loads((local / "mjthor_data_type_to_source_to_versions.json").read_text())
    for data_type, sources in installed.items():
        upstream = molmo_spaces_constants.DATA_TYPE_TO_SOURCE_TO_VERSION.get(data_type, {})
        if any(upstream.get(source) != version for source, version in sources.items()):
            raise ValueError("MolmoSpaces asset version differs from the pinned upstream release")
    # The native evaluation import checks the release-wide version table. Keep it intact
    # and supply a resource manager scoped to the mounted MS manipulation bundle.
    molmo_spaces_constants._RESOURCE_MANAGER = molmo_spaces_constants.get_resource_manager(
        data_type_to_source_to_version=installed
    )
    return scratch


class MolmoSpacesBenchmark(GymBenchmark):
    action_size = 8

    def __init__(self, reference, task):
        super().__init__(reference, task)
        self.sampler = None
        self.spec = None
        self.prompt = None

    def reset(self, sample):
        seed = self.reset_seed(sample)
        environment = self.reference["environment"]
        assets = Path(environment["assets"]["target"])
        catalog = assets / "assets" / environment["catalog"]
        index = int(sample["initialStateId"])
        episode = load_catalog(catalog, environment["initialStateDigests"][self.task])[index]
        if episode["robot"]["robot_name"] != "franka_droid":
            raise ValueError("MolmoSpaces MS manipulation requires the Franka DROID robot")
        offline_assets(str(assets))
        from molmo_spaces.evaluation.benchmark_schema import EpisodeSpec
        from molmo_spaces.evaluation.configs.evaluation_configs import PiPolicyEvalConfig
        from molmo_spaces.tasks.json_eval_task_sampler import JsonEvalTaskSampler
        import mujoco

        backend = environment.get("renderBackend")
        if backend is not None and getattr(mujoco, "mjRENDERER", "classic") != backend:
            raise ValueError("MolmoSpaces renderer differs from the frozen recipe")

        self.spec = EpisodeSpec.model_validate(episode)
        parameters = self.reference["parameters"]
        config = PiPolicyEvalConfig(seed=seed, task_horizon=self.horizon, num_workers=1,
                                    filter_for_successful_trajectories=False)
        if (config.policy_dt_ms != parameters["policyDtMs"] or config.ctrl_dt_ms != parameters["ctrlDtMs"]
                or config.sim_dt_ms != parameters["simDtMs"] or config.end_on_success != parameters["endOnSuccess"]
                or config.robot_config.command_mode != {"arm": "joint_position", "gripper": "joint_position"}):
            raise ValueError("MolmoSpaces native evaluation settings differ from the frozen recipe")
        self.sampler = JsonEvalTaskSampler(config, self.spec)
        self.env = self._sample_task()
        if self.env is None:
            raise ValueError("MolmoSpaces could not restore the selected official episode")
        raw, _info = self.env.reset()
        self.prompt = self.env.get_task_description()
        if not isinstance(self.prompt, str) or not self.prompt:
            raise ValueError("MolmoSpaces returned an empty task instruction")
        try:
            self.env.env.current_model.opt.enableflags |= int(mujoco.mjtEnableBit.mjENBL_SLEEP)
            self.env.env.current_model.opt.sleep_tolerance = 1e-3
        except AttributeError:
            # Older MuJoCo releases do not expose the sleep flag.
            pass
        self.steps = 0
        self.success = False
        return self.observation(raw)

    def _sample_task(self):
        if self.task not in ("open-v1", "close-v1"):
            return self.sampler.sample_task(house_index=self.spec.house_index)

        from molmo_spaces.utils import grasps

        # Scene-local iTHOR articulations have DROID grasp files but no standalone
        # object XML in the library used by the native automatic lookup.
        lookup = grasps.get_joint_grasp_path
        try:
            grasps.get_joint_grasp_path = partial(lookup, grasp_libraries=("droid",))
            return self.sampler.sample_task(house_index=self.spec.house_index)
        finally:
            grasps.get_joint_grasp_path = lookup

    def observation(self, raw):
        from molmo_spaces.policy.learned_policy.utils import resize_with_pad

        row, = raw
        shoulder = "droid_shoulder_light_randomization" if "droid_shoulder_light_randomization" in row else "exo_camera_1"
        shoulder = self.reference["environment"].get("frontCamera", shoulder)
        wrist = "wrist_camera_zed_mini" if "wrist_camera_zed_mini" in row else "wrist_camera"
        size = self.reference["parameters"]["renderSize"]
        return {
            "front_rgb": resize_with_pad(row[shoulder], size, size),
            "wrist_rgb": resize_with_pad(row[wrist], size, size),
            "state.arm": np.asarray(row["qpos"]["arm"][:7], dtype=np.float32),
            "state.gripper": np.asarray(row["qpos"]["gripper"][:1], dtype=np.float32),
            "instruction": self.prompt,
        }

    def step(self, action):
        command = np.asarray(action)
        if command.shape != (8,) or not np.isfinite(command).all() or command[7] not in (0, 255):
            raise ValueError("MolmoSpaces expects seven absolute DROID joints and a binary 0/255 gripper command")
        raw, rewards, terminated, truncated, _ = self.env.step({"arm": command[:7], "gripper": command[7:]})
        reward, = rewards
        done, = np.logical_or(terminated, truncated)
        self.steps += 1
        self.success = bool(self.env.judge_success())
        stopped = bool(done or (self.success and self.reference["parameters"]["endOnSuccess"]))
        return StepResult(self.observation(raw), float(reward), stopped, self.success,
                          simulation_time=self.steps * self.reference["parameters"]["policyDtMs"] / 1000,
                          native_action=command.tolist(), native_done=bool(done))

    def result(self):
        return {"success": self.success, "source": "MolmoSpaces native final judge_success",
                "task": self.task, "houseIndex": self.spec.house_index}

    def close(self):
        try:
            super().close()
        finally:
            if self.sampler is not None:
                self.sampler.close()
                self.sampler = None


def verify_molmospaces(controls, horizon, parameters):
    for step, row in enumerate(controls, 1):
        command, done, success = row["action"], row.get("nativeDone"), row["nativeSuccess"]
        if len(command) != 8 or command[7] not in (0, 255) or row.get("nativeAction") != command:
            raise ValueError("MolmoSpaces native command differs from the frozen DROID controls")
        stopped = done is True or (success is True and parameters["endOnSuccess"])
        if (type(done) is not bool or type(success) is not bool or row["terminated"] is not stopped
                or stopped != (step == len(controls)) or (step == horizon and not done)):
            raise ValueError("MolmoSpaces evidence differs from the native stopping protocol")
