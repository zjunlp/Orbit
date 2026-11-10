"""Native LIBERO-PRO BDDL conditions and indexed simulator-generated initial states."""

from pathlib import Path
import random

import numpy as np

from .binding import digest, file_digest, reset_seed
from .libero import LiberoBenchmark
from .libero_pro_catalog import TASK_ROOT


class LiberoProBenchmark(LiberoBenchmark):
    def __init__(self, reference, task):
        self.reference = reference
        self.environment = reference["environment"]
        self.mode = self.environment["perturbation"]
        suite, name = task.split(":", 1)
        if suite != self.environment["suite"] or task not in self.environment["tasks"]:
            raise ValueError("task is outside the selected LIBERO-PRO suite")
        super().__init__(suite, name, settle_steps=reference["parameters"]["settleSteps"])

    def reset(self, sample):
        from libero.libero.envs import OffScreenRenderEnv

        task = sample["taskId"]
        bddl = Path(TASK_ROOT) / (self.suite_name + "_" + self.mode) / self.task.bddl_file
        if (task != self.suite_name + ":" + self.task.name
                or file_digest(bddl) != sample["initialStateDigest"]
                or sample["initialStateDigest"] != self.environment["initialStateDigests"][task]):
            raise ValueError("LIBERO-PRO task or prepared BDDL differs from the frozen plan")
        seed = reset_seed(sample, self.reference) + int(sample["initialStateId"])
        random.seed(seed)
        np.random.seed(seed)
        self.env = OffScreenRenderEnv(bddl_file_name=str(bddl), camera_heights=256, camera_widths=256)
        self.instruction = self.env.language_instruction
        if self.instruction != self.environment["taskTitles"][task]:
            raise ValueError("LIBERO-PRO native language differs from the frozen BDDL")
        initial_state = self.env.get_sim_state()
        self.initial_digest = digest(np.asarray(initial_state).tolist())
        self.env.seed(seed)
        self.env.reset()
        return self.settle(self.env.set_init_state(initial_state))

    def observation(self, raw):
        return {**super().observation(raw), "instruction": self.instruction}

    def state(self, observation):
        return {**super().state(observation), "resetStateDigest": self.initial_digest,
                "instruction": observation["instruction"]}

    def result(self):
        return {**super().result(), "source": "LIBERO-PRO OffScreenRenderEnv.step.done",
                "instruction": self.instruction, "perturbation": self.mode}
