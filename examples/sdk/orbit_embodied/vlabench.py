"""Native VLABench track catalog and Franka end-effector evaluation."""

import ast
import copy
import json
from inspect import signature
from math import isfinite
from pathlib import Path
import random

from .binding import file_digest, reset_seed, seed_asset


TRACKS = (
    "track_1_in_distribution", "track_2_cross_category", "track_3_common_sense",
    "track_4_semantic_instruction", "track_5_cross_task", "track_6_unseen_texture",
)
OPEN_TRACK = TRACKS[4]
CAMERAS = {"front_rgb": (2, "forward"), "wrist_rgb": (3, "franka/Franka_wrist_cam"),
           "right_rgb": (0, "right"), "left_rgb": (1, "left")}
RENDER_SIZE = 480
NATIVE_ROOT = "/opt/vlabench/VLABench"
ASSETS_ROOT = "/opt/vlabench-assets"
METRICS = {"intention_score": "Intention score", "progress_score": "Progress score"}


def track_path(track):
    if track not in TRACKS:
        raise ValueError("unknown VLABench track")
    return "configs/evaluation/tracks/" + track + ".json"


def native_tasks(root):
    """Read literal task decorators from modules imported by VLABench.tasks."""
    pending = ["VLABench.tasks"]
    visited, names = set(), set()
    while pending:
        module = pending.pop()
        if module in visited:
            continue
        visited.add(module)
        path = root / module.replace(".", "/")
        tree = ast.parse((path / "__init__.py" if path.is_dir() else path.with_suffix(".py")).read_text())
        for node in tree.body:
            if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("VLABench.tasks.hierarchical_tasks"):
                pending.append(node.module)
            if isinstance(node, ast.ClassDef):
                for decorator in node.decorator_list:
                    if (isinstance(decorator, ast.Call) and isinstance(decorator.func, ast.Attribute)
                            and decorator.func.attr == "add_task"):
                        names.add(ast.literal_eval(decorator.args[0]))
    return sorted(names)


def track_catalog(root, track):
    root = Path(root)
    path = root / "VLABench" / track_path(track)
    episodes = json.loads(path.read_text()) if track != OPEN_TRACK else None
    known = set(native_tasks(root))
    names = sorted(known if episodes is None else episodes)
    if not names or not set(names) <= known or (episodes is not None and not all(episodes.values())):
        raise ValueError("VLABench track does not match the released task registry")
    configs = root / "VLABench/configs"
    task_configs = json.loads((configs / "task_config.json").read_text())
    series = ast.literal_eval(ast.parse((configs / "__init__.py").read_text()).body[0].value)
    config_for = {task: family for family, tasks in series.items() for task in tasks}
    horizons = {name: task_configs.get(config_for.get(name), {}).get("evaluation", {})
                                  .get("max_episode_length") or 200 for name in names}
    return names, horizons, {name: len(episodes[name]) for name in names} if episodes is not None else {}


def initial_state_count(environment, task):
    return environment.get("vlabenchEpisodeCounts", {}).get(task)


class VLABenchBenchmark:
    action_size = 8
    settle_steps = 0
    video = None
    env = None

    def __init__(self, reference, task):
        self.reference = reference
        self.task = task
        self.horizon = reference["environment"]["horizons"][task]
        self.success = False

    def reset(self, sample):
        import numpy as np
        import VLABench.robots
        import VLABench.tasks
        from VLABench.envs import ROBOT_CONFIG, TASK_CONFIG, load_env

        environment = self.reference["environment"]
        if sample["taskId"] != self.task or seed_asset(self.reference, self.task) != sample["initialStateDigest"]:
            raise ValueError("VLABench reset recipe differs from the frozen sample")
        if "random_state" not in signature(load_env).parameters:
            raise ValueError("rebuild the VLABench image with the seeded native loader")
        seed = reset_seed(sample, self.reference)
        np.random.seed(seed)
        random.seed(seed)
        track = environment["track"]
        episode = None
        if track != OPEN_TRACK:
            path = track_path(track)
            source = Path(NATIVE_ROOT) / path
            if file_digest(source) != self.reference["reference"]["files"]["VLABench/" + path]:
                raise ValueError("VLABench runtime track differs from the frozen source")
            episodes = json.loads(source.read_text())[self.task]
            if len(episodes) != initial_state_count(environment, self.task):
                raise ValueError("VLABench runtime track count differs from the frozen source")
            episode = episodes[int(sample["initialStateId"])]
        # load_env mutates the global default task and robot dictionaries.
        defaults, robots = copy.deepcopy(TASK_CONFIG), copy.deepcopy(ROBOT_CONFIG)
        try:
            self.env = load_env(self.task, episode_config=episode, random_init=episode is None,
                                random_state=np.random.RandomState(seed), eval=False, run_mode="eval")
            self.env.reset()
        finally:
            TASK_CONFIG.clear()
            TASK_CONFIG.update(defaults)
            ROBOT_CONFIG.clear()
            ROBOT_CONFIG.update(robots)
        self.robot_base = np.asarray(self.env.get_robot_frame_position(), dtype=np.float64).copy()
        return self.observation()

    def observation(self):
        import numpy as np

        return {**{field: self.env.render(camera_id=index, **self.env.render_options)
                   for field, (index, _) in CAMERAS.items()},
                "ee_state": np.asarray(self.env.robot.get_ee_state(self.env.physics), dtype=np.float64),
                "robot_base": self.robot_base, "instruction": self.env.task.get_instruction()}

    @staticmethod
    def state(observation):
        return {"eeState": observation["ee_state"].tolist(), "robotBase": observation["robot_base"].tolist()}

    def step(self, action):
        import numpy as np
        from VLABench.utils.utils import euler_to_quaternion
        from .driver import StepResult

        _, qpos = self.env.robot.get_qpos_from_ee_pos(physics=self.env.physics, pos=action[:3],
                                                       quat=euler_to_quaternion(*action[3:6]))
        command = np.concatenate([qpos, action[6:]])
        timestep = self.env.step(command)
        self.success = bool(timestep.last())
        return StepResult(self.observation(), float(timestep.reward or 0), self.success, self.success,
                          float(self.env.physics.data.time), native_action=command.tolist())

    def result(self):
        from VLABench.tasks.dm_task import LM4ManipBaseTask

        task = self.env.task
        metrics = {}
        for name, method, tracking_field, options in (
            ("progress_score", "get_task_progress", "target_is_grasped", {}),
            ("intention_score", "get_intention_score", "intention_distance", {"threshold": 0.1}),
        ):
            if not hasattr(task, tracking_field) and getattr(type(task), method) is getattr(LM4ManipBaseTask, method):
                continue
            try:
                value = float(getattr(self.env, method)(**options))
            except AttributeError as exc:
                # An override can still delegate to a scorer whose tracker was disabled.
                if getattr(exc, "obj", None) is task and getattr(exc, "name", None) == tracking_field:
                    continue
                raise
            except KeyError:
                # Matches OpenWAM's treatment of upstream missing target keys.
                if name == "intention_score":
                    continue
                raise
            if isfinite(value):
                metrics[name] = value
        return {"success": self.success, "source": "VLABench evaluator timestep.last",
                "task": self.task, "metrics": metrics}

    def start_video(self, directory):
        import imageio

        self.video = imageio.get_writer(str(Path(directory) / "video.mp4"), fps=10)

    def record_frame(self, observation):
        self.video.append_data(observation["front_rgb"])

    def finish_video(self):
        if self.video is not None:
            self.video.close()
            self.video = None

    def close(self):
        if self.env is not None:
            self.env.close()
