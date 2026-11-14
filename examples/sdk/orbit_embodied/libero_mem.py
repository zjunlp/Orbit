"""Native LIBERO-Mem sequence progress and CPU evidence verification."""

from pathlib import Path
import re

import numpy as np

from .binding import file_digest, reset_seed
from .driver import StepResult
from .libero import LiberoBenchmark


SUITE = "libero_mem"
INIT_ROOT = Path("/opt/libero-mem/libero/libero/init_files/libero_mem")


def goal_branches(goals):
    expression, = goals
    sequences = expression[1:] if expression[0] == "or" else [expression]
    if not sequences or any(branch[0] != "sequence" or len(branch) < 2 for branch in sequences):
        raise ValueError("LIBERO-Mem requires ordered native subgoals")
    return [branch[1:] for branch in sequences]


def native_catalog():
    from libero.libero import benchmark, get_libero_path
    from libero.libero.envs.bddl_utils import robosuite_parse_problem

    suite = benchmark.get_benchmark_dict()[SUITE]()
    bddl_root = Path(get_libero_path("bddl_files")) / SUITE
    rows = {}
    for index, task in enumerate(suite.tasks):
        path = INIT_ROOT / task.init_states_file
        branches = goal_branches(robosuite_parse_problem(str(bddl_root / task.bddl_file))["goal_state"])
        count, = {len(branch) for branch in branches}
        states = suite.get_task_init_states(index)
        if not len(states):
            raise ValueError("missing LIBERO-Mem initial states")
        rows[f"{SUITE}:{task.name}"] = {
            "count": len(states), "digest": file_digest(path), "subgoals": count, "goalBranches": branches,
            "instruction": re.sub(r"^\d+\s+", "", task.language), "horizon": max(300, 250 * count),
        }
    return rows


class LiberoMemBenchmark(LiberoBenchmark):
    def __init__(self, reference, task):
        self.reference = reference
        self.entry = reference["environment"]["catalog"][task]
        self.instruction = self.entry["instruction"]
        self.progress = []
        self.predicates = []
        self.overshot = False
        suite, name = task.split(":", 1)
        super().__init__(suite, name, settle_steps=reference["parameters"]["settleSteps"],
                         horizon=self.entry["horizon"])

    def reset(self, sample):
        from libero.libero import get_libero_path
        from libero.libero.envs import OffScreenRenderEnv

        seed = reset_seed(sample, self.reference)
        path = self.initial_state_file(Path(get_libero_path("init_states")))
        if (sample["taskId"] != f"{SUITE}:{self.task.name}" or path.parent.resolve() != INIT_ROOT
                or file_digest(path) != self.entry["digest"] or sample["initialStateDigest"] != self.entry["digest"]):
            raise ValueError("LIBERO-Mem initial states differ from the frozen catalog")
        states = self.suite.get_task_init_states(self.task_index)
        if len(states) != self.entry["count"]:
            raise ValueError("LIBERO-Mem initial state count differs from the catalog")
        bddl = Path(get_libero_path("bddl_files")) / SUITE / self.task.bddl_file
        np.random.seed(seed)
        self.env = OffScreenRenderEnv(bddl_file_name=str(bddl), camera_heights=256, camera_widths=256,
                                      horizon=self.horizon + 100)
        if goal_branches(self.env.env.parsed_problem["goal_state"]) != self.entry.get("goalBranches"):
            raise ValueError("LIBERO-Mem goals differ from the frozen task")
        self.env.seed(seed)
        self.env.reset()
        raw = self.env.set_init_state(self.initial_state(sample, states))
        self.env.env.reset_subgoal_progress()
        self.reset_actions = []
        for step in range(self.settle_steps):
            action = [0.0] * 6 + [-1.0]
            raw, reward, done, _ = self.env.step(action)
            self.advance_progress(done)
            self.reset_actions.append({"phase": "settle", "step": step, "action": action,
                                       "reward": float(reward), "terminated": bool(done)})
        self.success = False
        return self.observation(raw)

    def advance_progress(self, done):
        native = self.env.env
        advanced = native._check_success(inc=True)
        self.progress = native.get_satisfied_subgoals(self.instruction)
        self.predicates = list(native._satisfied_subgoals)
        self.overshot = bool(native._overshot)
        return not self.overshot and bool(done or advanced) and len(self.predicates) == self.entry["subgoals"]

    def observation(self, raw):
        return {**super().observation(raw), "instruction": self.instruction}

    def state(self, observation):
        return {**super().state(observation), "instruction": self.instruction,
                "satisfiedSubgoals": self.progress, "satisfiedPredicates": self.predicates, "overshot": self.overshot}

    def step(self, action):
        raw, reward, done, _ = self.env.step(action.tolist())
        self.success = self.advance_progress(done)
        return StepResult(self.observation(raw), float(reward), self.success, self.success,
                          float(self.env.env.sim.data.time))

    def result(self):
        return {**super().result(), "source": "LIBERO-Mem native ordered subgoals",
                "completedSubgoals": len(self.predicates), "totalSubgoals": self.entry["subgoals"],
                "satisfiedSubgoals": self.progress, "satisfiedPredicates": self.predicates, "overshot": self.overshot}


def verify_mem_episode(reference, sample, initial, controls, result):
    entry = reference["environment"]["catalog"][sample["taskId"]]
    total = entry["subgoals"]
    branches = entry.get("goalBranches")
    if not branches or any(len(branch) != total for branch in branches):
        raise ValueError("missing frozen LIBERO-Mem goal branches; regenerate the registration and replay the sample")
    states = [initial] + [row["state"] for row in controls]
    previous, overshot = [], False
    for state in states:
        progress = state.get("satisfiedPredicates")
        labels = state.get("satisfiedSubgoals")
        if (state["instruction"] != entry["instruction"] or not isinstance(progress, list)
                or not isinstance(labels, list) or len(labels) != len(progress)
                or any(not isinstance(label, str) or not label for label in labels)
                or not len(previous) <= len(progress) <= min(len(previous) + 1, total)
                or progress[:len(previous)] != previous
                or not any(progress == branch[:len(progress)] for branch in branches)
                or type(state["overshot"]) is not bool
                or (overshot and not state["overshot"])
                or (state["overshot"] and len(progress) != total)):
            raise ValueError("LIBERO-Mem ordered subgoal evidence is inconsistent")
        previous, overshot = progress, state["overshot"]
    for index, (row, state) in enumerate(zip(controls, states[1:])):
        success = len(state["satisfiedPredicates"]) == total and not state["overshot"]
        if (row["nativeSuccess"] is not success or row["terminated"] is not success
                or (success and index != len(controls) - 1)):
            raise ValueError("LIBERO-Mem native success or stopping differs from subgoal evidence")
    native = result["native"]
    if (native["completedSubgoals"] != len(previous) or native["totalSubgoals"] != total
            or native.get("satisfiedPredicates") != previous
            or native["satisfiedSubgoals"] != states[-1]["satisfiedSubgoals"] or native["overshot"] is not overshot):
        raise ValueError("LIBERO-Mem native score differs from the control trace")
