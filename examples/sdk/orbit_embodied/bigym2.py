"""BiGym 2.0 protocol-v1 G1 manipulation with the frozen lower-body controller."""

from pathlib import Path

import numpy as np

from .binding import reset_seed
from .driver import StepResult
from .gym import GymBenchmark


CAMERAS = ("head", "right_wrist", "left_wrist")


def native_catalog():
    import bigym
    from bigym.loco.eval.protocol import EVAL_EPISODES, EVAL_PROTOCOL_VERSION, EVAL_SEED_BASE
    from bigym.loco.fingerprint import SUBSTRATE_VERSION
    from bigym.loco.tasks import DATA_DERIVED_BUDGET_TASKS, TASKS
    from bigym.robots.configs.g1 import G1_LEFT_ARM_JOINT_NAMES, G1_RIGHT_ARM_JOINT_NAMES
    import yaml

    instructions = yaml.safe_load((Path(bigym.__file__).parent / "loco/demos/task_instructions.yaml").read_text())
    rows = {}
    for task in sorted(DATA_DERIVED_BUDGET_TASKS):
        config = TASKS[task].config()
        rows[task] = {"horizon": config.episode_length // config.demo_down_sample_rate,
                      "pitch": config.controller.pitch_command, "instruction": instructions[task]}
    return {"tasks": rows, "episodes": EVAL_EPISODES, "seed": EVAL_SEED_BASE,
            "protocol": EVAL_PROTOCOL_VERSION, "substrate": SUBSTRATE_VERSION, "armOrder": list(G1_LEFT_ARM_JOINT_NAMES + G1_RIGHT_ARM_JOINT_NAMES)}


def profile(pitch, arms):
    order = ["vx", "vy", "height", "wz"] + (["torso_pitch"] if pitch else [])
    order += list(arms) + ["left_gripper", "right_gripper"]
    return {
        "id": "bigym2-g1-" + ("pitch" if pitch else "no-pitch") + "/1",
        "observations": {
            **{name + "_rgb": {"semantic": "rgb", "dtype": "uint8", "shape": [84, 84, 3],
                              "camera": name, "layout": "HWC"} for name in CAMERAS},
            "state.proprioception": {"semantic": "bigym2-g1-proprioception", "dtype": "float32",
                                     "shape": [56 if pitch else 50]},
            "instruction": {"semantic": "task-instruction", "dtype": "string", "shape": []},
        },
        "action": {"semantic": "bigym2-g1-whole-body-action", "shape": [len(order)], "order": order,
                   "controller": "groot-wbc", "frame": "g1-body", "unit": "normalized[-1,1]",
                   "rotation": "joint-targets-and-base-yaw-rate", "gripper": "normalized-closure"},
    }


class BiGym2Benchmark(GymBenchmark):
    def __init__(self, reference, task):
        super().__init__(reference, task)
        self.action_size = reference["benchmarkProfile"]["action"]["shape"][0]
        self.instruction = reference["environment"]["taskTitles"][task]
        self.episode = {}

    def reset(self, sample):
        from bigym.loco import make
        from bigym.loco.eval import protocol_violations
        from bigym.loco.fingerprint import SUBSTRATE_VERSION

        self.seed = self.reset_seed(sample)
        self.env = make(self.task)
        if (protocol_violations(self.env) or SUBSTRATE_VERSION != self.reference["reference"]["substrateVersion"]
                or self.env.config.episode_length // self.env.config.demo_down_sample_rate != self.horizon
                or tuple(self.env.config.camera_keys) != CAMERAS
                or self.env.action_spec().shape != (self.action_size,)
                or list(self.env.wholebody_action_layout()["limb_names"]) !=
                self.reference["benchmarkProfile"]["action"]["order"][-16:-2]
                or list(self.env.low_dim_observation_spec().shape) !=
                self.reference["benchmarkProfile"]["observations"]["state.proprioception"]["shape"]):
            raise ValueError("BiGym 2.0 runtime differs from the frozen official recipe")
        timestep = self.env.reset(seed=self.seed)
        self.episode = {"taskSucceeded": False, "fell": False, "truncation": None}
        self.steps, self.success = 0, False
        return self.observation(timestep)

    def observation(self, timestep):
        return {**{camera + "_rgb": np.moveaxis(frame, 0, -1)
                   for camera, frame in zip(CAMERAS, timestep.rgb_obs)},
                "state.proprioception": timestep.low_dim_obs, "instruction": self.instruction}

    def state(self, observation):
        return {**super().state(observation), "instruction": self.instruction, **self.episode}

    def step(self, action):
        from bigym.loco.eval import is_success

        native = np.asarray(action, dtype=np.float32)
        timestep = self.env.step(native)
        self.steps += 1
        self.episode = {"taskSucceeded": bool(self.env.episode_succeeded()), "fell": bool(self.env.episode_fell()),
                        "truncation": self.env.last_truncation_reason()}
        self.success = bool(is_success(self.env))
        return StepResult(self.observation(timestep), float(timestep.reward or 0), bool(timestep.last()),
                          self.success, simulation_time=self.steps / self.control_hz,
                          native_action=native.tolist(), native_done=bool(timestep.last()))

    def result(self):
        return {"source": "BiGym 2.0 protocol v1", "task": self.task, "seed": self.seed,
                "success": self.success, "termination": self.env.episode_termination(), **self.episode}


def verify_bigym2(reference, sample, controls, result):
    task = sample["taskId"]
    horizon = reference["environment"]["horizons"][task]
    instruction = reference["environment"]["taskTitles"][task]
    fell = succeeded = False
    for step, row in enumerate(controls, start=1):
        state = row["state"]
        raw_done, truncation = row["nativeDone"], state["truncation"]
        if (type(raw_done) is not bool or state["instruction"] != instruction
                or type(state["fell"]) is not bool or type(state["taskSucceeded"]) is not bool
                or (fell and not state["fell"]) or (succeeded and not state["taskSucceeded"])
                or truncation not in (None, "time_limit", "physics_error")
                or (step == horizon and not raw_done)
                or (truncation == "time_limit" and step != horizon)):
            raise ValueError("invalid BiGym 2.0 control or termination evidence")
        fell, succeeded = state["fell"], state["taskSucceeded"]
        if (row["terminated"] is not raw_done or raw_done != (step == len(controls))
                or (truncation is not None and not raw_done)
                or row["nativeSuccess"] is not (succeeded and not fell)
                or not np.array_equal(np.asarray(row["action"], dtype=np.float32), row["nativeAction"])):
            raise ValueError("BiGym 2.0 action, success or stopping evidence differs")
    termination = ("fell" if fell else "success" if succeeded else "timeout" if truncation == "time_limit"
                   else "physics_error" if truncation == "physics_error" else "terminated")
    expected = {"source": "BiGym 2.0 protocol v1", "task": task, "seed": reset_seed(sample, reference),
                "success": succeeded and not fell, "termination": termination, "fell": fell,
                "taskSucceeded": succeeded, "truncation": truncation}
    if result["native"] != expected:
        raise ValueError("BiGym 2.0 verdict differs from native control evidence")
