"""Native CLIPort RGB-D observations, manipulation primitives and cumulative rewards."""

import random

import numpy as np

from .binding import reference_horizon, reset_seed
from .driver import StepResult
from .gym import GymBenchmark


CAMERAS = ("front", "left", "right")
ASSETS_ROOT = "/opt/cliport/cliport/environments/assets"
GOOGLE_ASSETS = ASSETS_ROOT + "/google"
TEST_SEED = 10001
SUCCESS_REWARD = 0.99


ACTIONS = {
    "pick-place": {"semantic": "pick-place-pose-pair", "shape": [14],
                   "order": [prefix + "." + key for prefix in ("pick", "place")
                             for key in ("x", "y", "z", "qx", "qy", "qz", "qw")],
                   "controller": "cliport-pick-place", "frame": "world", "unit": "m",
                   "rotation": "quaternion-xyzw", "gripper": "suction-primitive"},
    "push": {"semantic": "push-xy-endpoints", "shape": [4],
             "order": ["start.x", "start.y", "end.x", "end.y"],
             "controller": "cliport-push", "frame": "world", "unit": "m",
             "rotation": "derived-from-push-direction", "gripper": "spatula"},
}


def task_primitive(task):
    from cliport.tasks import primitives
    from cliport.tasks.grippers import Spatula, Suction

    if isinstance(task.primitive, primitives.PickPlace) and task.ee is Suction:
        return "pick-place"
    if task.primitive is primitives.push and task.ee is Spatula:
        return "push"
    raise ValueError("unsupported CLIPort primitive or end effector")


def native_catalog():
    from cliport import tasks
    from cliport.dataset import RavensMultiTaskDataset

    names = RavensMultiTaskDataset.MULTI_TASKS["multi-language-conditioned"]["test"]
    return {name: task_primitive(tasks.names[name]()) for name in names}


def profile(endpoint, primitive):
    return {
        "id": f"cliport-{endpoint}-{primitive}-rgbd/1",
        "observations": {
            **{name + "_rgb": {"semantic": "rgb", "dtype": "uint8", "shape": [480, 640, 3],
                              "camera": name, "layout": "HWC"} for name in CAMERAS},
            **{name + "_depth": {"semantic": "depth", "dtype": "float32", "shape": [480, 640],
                                "camera": name, "unit": "m", "layout": "HW"} for name in CAMERAS},
            "instruction": {"semantic": "task-instruction", "dtype": "string", "shape": []},
        },
        "action": ACTIONS[primitive],
    }


def start_test_episode(env, task, seed):
    from cliport.utils import utils

    # Match the test-dataset oracle's seed for both RNGs; some task resets use random.sample.
    np.random.seed(seed)
    random.seed(seed)
    env.seed(seed)
    task.mode = "test"
    env.set_task(task)
    # Kitting, packing shapes and pyramid stacking shuffle the shared palettes in place.
    # Preserve the upstream first-reset palette order across episodes and batch layouts.
    train_colors, eval_colors = utils.TRAIN_COLORS[:], utils.EVAL_COLORS[:]
    try:
        return env.reset()
    finally:
        utils.TRAIN_COLORS[:] = train_colors
        utils.EVAL_COLORS[:] = eval_colors


def native_action(primitive, action):
    if primitive == "push":
        # PyBullet's native push reads XY from both poses and supplies its own height and rotation.
        return {"pose0": ([*action[:2], 0.0], [0.0, 0.0, 0.0, 1.0]),
                "pose1": ([*action[2:], 0.0], [0.0, 0.0, 0.0, 1.0])}
    return {"pose0": (action[:3], action[3:7]), "pose1": (action[7:10], action[10:14])}


def flatten_action(action):
    return np.concatenate([part for name in ("pose0", "pose1") for part in action[name]])


class CLIPortBenchmark(GymBenchmark):
    def __init__(self, reference, sample):
        super().__init__(reference, sample["taskId"], sample=sample)
        self.primitive = reference["environment"]["primitive"]
        self.action_size = ACTIONS[self.primitive]["shape"][0]
        self.rng = None

    def reset(self, sample):
        from cliport import tasks
        from cliport.environments.environment import Environment
        import pybullet

        self.seed = self.reset_seed(sample)
        task = tasks.names[self.task]()
        if pybullet.isConnected():
            raise ValueError("CLIPort requires a fresh native simulator")
        self.rng = random.getstate(), np.random.get_state()
        self.env = Environment(ASSETS_ROOT, disp=False, shared_memory=False, hz=480)
        self.score, self.steps = 0.0, 0
        self.success = False
        raw = start_test_episode(self.env, task, self.seed)
        if task_primitive(task) != self.primitive:
            raise ValueError("CLIPort task primitive or end effector differs from the frozen profile")
        if task.max_steps != self.horizon:
            raise ValueError("CLIPort reset horizon differs from the frozen sample")
        return self.observation(raw, self.env.info)

    @staticmethod
    def observation(raw, info):
        return {**{name + "_rgb": image for name, image in zip(CAMERAS, raw["color"])},
                **{name + "_depth": np.asarray(depth, dtype=np.float32)
                   for name, depth in zip(CAMERAS, raw["depth"])},
                "instruction": info["lang_goal"]}

    def state(self, observation):
        return {"instruction": observation["instruction"], "totalReward": self.score}

    def step(self, action):
        command = native_action(self.primitive, action)
        raw, reward, done, info = self.env.step(command)
        self.steps += 1
        self.score += float(reward)
        self.success = self.score > SUCCESS_REWARD
        return StepResult(self.observation(raw, info), float(reward), bool(done) or self.steps == self.horizon,
                          self.success, native_action=flatten_action(command).tolist(), native_done=bool(done))

    def result(self):
        return {"source": "CLIPort test mean reward", "task": self.task, "seed": self.seed, "primitive": self.primitive,
                "success": self.success, "totalReward": self.score}

    def close(self):
        if self.rng is not None:
            import pybullet
            try:
                if pybullet.isConnected():
                    pybullet.disconnect()
            finally:
                random.setstate(self.rng[0])
                np.random.set_state(self.rng[1])
                self.rng = self.env = None


def verify_cliport(reference, sample, controls, result):
    task = sample["taskId"]
    primitive = reference["environment"]["primitive"]
    horizon = reference_horizon(reference, task, sample=sample)
    if len(controls) > horizon:
        raise ValueError("CLIPort controls exceed the frozen sample horizon")
    total = 0.0
    for step, row in enumerate(controls, start=1):
        total += row["reward"]
        done = row["nativeDone"]
        stopped = done or step == horizon
        state = row["state"]
        if (type(done) is not bool or row["terminated"] is not stopped or stopped != (step == len(controls))
                or len(row["action"]) != ACTIONS[primitive]["shape"][0]
                or flatten_action(native_action(primitive, row["action"])).tolist() != row["nativeAction"]
                or row["nativeSuccess"] is not (total > SUCCESS_REWARD)
                or not isinstance(state["instruction"], str) or state["totalReward"] != total
                or not -1e-7 <= total <= 1 + 1e-7):
            raise ValueError("CLIPort control evidence differs from native reward or stopping rules")
    expected = {"source": "CLIPort test mean reward", "task": task, "seed": reset_seed(sample, reference),
                "primitive": primitive, "success": total > SUCCESS_REWARD, "totalReward": total}
    if result["native"] != expected:
        raise ValueError("CLIPort cumulative reward differs from the recorded controls")
