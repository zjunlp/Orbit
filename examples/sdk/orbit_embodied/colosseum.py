"""Native Colosseum V2 single-environment episodes and source catalog extraction."""

import ast
from copy import deepcopy
from pathlib import Path
import random

import numpy as np

from .driver import StepResult
from .gym import GymBenchmark


CATALOG_PATH = "/opt/colosseum-v2/eval_rgbd.py"
CABINET_MODELS = {
    "OpenDrawer-v1": "1027",
    "OpenCabinet-v1": "1027",
    "PlaceCubeInDrawer-v1": "45427",
    "DualArmDrawerOpen-v1": "1005",
    "DualArmDrawerPlace-v1": "1005",
}
SODA_FIXTURES = (
    "cabinet_open.xml", "visuals/wood1.png",
    "cabinet_panels/shelf.xml", "cabinet_panels/visuals/wood1.png",
)


def has_cabinet(model):
    from mani_skill import ASSET_DIR, PACKAGE_ASSET_DIR

    return any((root / "partnet_mobility" / "dataset" / model / name).is_file()
               for root in (ASSET_DIR, PACKAGE_ASSET_DIR)
               for name in ("mobility_cvx.urdf", "mobility_fixed.urdf", "mobility.urdf"))


def official_task_tables(evaluator):
    names = {"ALL_COLOSSEUM_V2_SINGLE_ARM_TASKS", "ALL_COLOSSEUM_V2_BIMANUAL_TASKS", "TASK_TEXT_MAP"}
    source = ast.parse(Path(evaluator).read_text())
    values = {
        node.targets[0].id: ast.literal_eval(node.value)
        for node in source.body
        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and node.targets[0].id in names
    }
    return {"single-arm": values["ALL_COLOSSEUM_V2_SINGLE_ARM_TASKS"],
            "bimanual": values["ALL_COLOSSEUM_V2_BIMANUAL_TASKS"]}, values["TASK_TEXT_MAP"]


def native_catalog(evaluator=CATALOG_PATH):
    from mani_skill import ASSET_DIR
    import mani_skill.envs  # noqa: F401
    from mani_skill.envs.tasks.tabletop.colosseum_v2 import MAX_EPISODE_STEPS_BY_TASK
    from mani_skill.envs.tasks.tabletop.colosseum_v2.perturbation_set import PERTURBATION_SETS
    from mani_skill.utils.assets import DATA_GROUPS, expand_data_group_into_individual_data_source_ids, is_data_source_downloaded
    from mani_skill.utils.registration import REGISTERED_ENVS

    morphologies, instructions = official_task_tables(evaluator)
    presets = list(PERTURBATION_SETS)
    if ({name: len(tasks) for name, tasks in morphologies.items()} != {"single-arm": 16, "bimanual": 12}
            or len(presets) != 21 or set().union(*map(set, morphologies.values())) != set(MAX_EPISODE_STEPS_BY_TASK)):
        raise ValueError("unexpected native Colosseum V2 task or perturbation catalog")
    tasks = {}
    for task in MAX_EPISODE_STEPS_BY_TASK:
        spec = REGISTERED_ENVS[task]
        disabled = getattr(spec.cls, "DISABLED_PERTURBATION_FACTORS", None)
        required = {source for key in spec.asset_download_ids or ()
                    for source in (expand_data_group_into_individual_data_source_ids(key) if key in DATA_GROUPS else (key,))}
        if task in CABINET_MODELS:
            required = {"partnet_mobility/" + CABINET_MODELS[task]}
        if task == "PickSodaFromCabinet-v1":
            required.add("RoboCasa")
        tasks[task] = {
            "horizon": MAX_EPISODE_STEPS_BY_TASK[task],
            "instruction": instructions[task],
            "assets": sorted(required),
            "disabled": [key for key, preset in PERTURBATION_SETS.items()
                         if disabled is not None and not preset.all_are_enabled()
                         and any(preset.perturbation_is_enabled(factor) for factor in disabled.to_list())],
        }
    distractor_assets = ["ycb"]
    assets = {key for task in tasks.values() for key in task["assets"]} | set(distractor_assets)
    missing = {key for key in assets if not (has_cabinet(key.split("/")[1]) if key.startswith("partnet_mobility/")
                                             else is_data_source_downloaded(key))}
    fixtures = ASSET_DIR / "scene_datasets/robocasa_dataset/assets/fixtures/cabinets"
    if not all((fixtures / name).is_file() for name in SODA_FIXTURES):
        missing.add("RoboCasa")
    return {"morphologies": morphologies, "tasks": tasks, "presets": presets,
            "distractorAssets": distractor_assets,
            "missingAssets": sorted(missing)}


class ColosseumBenchmark(GymBenchmark):
    def __init__(self, reference, task):
        super().__init__(reference, task)
        self.config = reference["environment"]
        if task in self.config.get("unsupported", {}):
            raise ValueError("unavailable Colosseum V2 task: " + self.config["unsupported"][task])
        self.profile = reference["benchmarkProfile"]
        self.action_size = self.profile["action"]["shape"][0]
        self.success_at_end = False

    def reset(self, sample):
        import gymnasium as gym
        import mani_skill.envs  # noqa: F401
        from mani_skill.envs.tasks.tabletop.colosseum_v2 import MAX_EPISODE_STEPS_BY_TASK
        from mani_skill.envs.tasks.tabletop.colosseum_v2.perturbation_set import PERTURBATION_SETS
        from mani_skill.utils.registration import REGISTERED_ENVS

        seed = self.reset_seed(sample)
        if MAX_EPISODE_STEPS_BY_TASK[self.task] != self.horizon:
            raise ValueError("Colosseum V2 task horizon differs from the pinned evaluator")
        config = deepcopy(PERTURBATION_SETS[self.config["perturbation"]].to_dict())
        py_state, np_state = random.getstate(), np.random.get_state()
        random.seed(seed)
        np.random.seed(seed)
        spec = REGISTERED_ENVS[self.task]
        asset_download_ids = spec.asset_download_ids
        try:
            if self.task in CABINET_MODELS:
                model = CABINET_MODELS[self.task]
                if not has_cabinet(model):
                    raise ValueError("missing native PartNet cabinet model: " + model)
                # The native task uses one fixed cabinet. Its download gate asks for the full dataset.
                spec.asset_download_ids = []
            self.env = gym.make(self.task, num_envs=1, sim_backend="physx_cuda", reconfiguration_freq=1,
                                control_mode=self.profile["action"]["controller"], reward_mode="sparse",
                                obs_mode="rgb", max_episode_steps=self.horizon, perturbation_set=config,
                                _env_id=self.task, disable_env_checker=True)
            native = self.env.unwrapped
            if native.single_action_space.shape != (self.action_size,) or native.control_freq != self.control_hz:
                raise ValueError("Colosseum V2 control settings differ from the frozen profile")
            self.instruction, = native.update_language_instructions([self.config["instructions"][self.task]])
            raw, _ = self.env.reset(seed=seed)
        finally:
            spec.asset_download_ids = asset_download_ids
            random.setstate(py_state)
            np.random.set_state(np_state)
        self.success, self.success_at_end, self.steps = False, False, 0
        return self.observation(raw)

    def observation(self, raw):
        from mani_skill.utils.common import flatten_state_dict

        fields = self.profile["observations"]
        cameras = {key: field["camera"] for key, field in fields.items() if field["semantic"] == "rgb"}
        if tuple(raw["sensor_data"]) != tuple(cameras.values()):
            raise ValueError("Colosseum V2 camera order differs from the frozen profile")
        obs = {key: raw["sensor_data"][camera]["rgb"][0].cpu().numpy().copy()
               for key, camera in cameras.items()}
        # The ACT evaluator excludes the two convenience transformation matrices.
        agent = {key: value for key, value in raw["agent"].items() if key not in ("world__T__ee", "world__T__root")}
        obs["state"] = flatten_state_dict({"agent": agent, "extra": raw["extra"]}, use_torch=True)[0].cpu().numpy().copy()
        obs["instruction"] = self.instruction
        return obs

    @staticmethod
    def state(observation):
        return {"state": observation["state"].tolist(), "instruction": observation["instruction"]}

    def step(self, action):
        command = np.asarray(action, dtype=np.float32)
        raw, reward, done, truncated, info = self.env.step(command[None, :])
        self.steps += 1
        finished = self.steps == self.horizon
        if bool(truncated) != finished:
            raise ValueError("Colosseum V2 truncation differs from the pinned evaluator horizon")
        self.success_at_end = bool(info["success"])
        self.success = self.success or self.success_at_end
        return StepResult(self.observation(raw), float(reward), finished, self.success_at_end,
                          native_action=command.tolist(), native_done=bool(done))

    def result(self):
        return {"success": self.success, "successOnce": self.success, "successAtEnd": self.success_at_end,
                "source": "native Colosseum V2 success_once", "task": self.task,
                "perturbation": self.config["perturbation"]}
