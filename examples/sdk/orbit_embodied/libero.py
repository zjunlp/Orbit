"""Direct LIBERO environment access; model serving is a separate endpoint."""

from __future__ import annotations

from pathlib import Path
import numpy as np

from .driver import StepResult
from .evidence import file_digest
from .libero_suites import HORIZONS


class LiberoBenchmark:
    action_size = 7
    settle_steps = 10

    def __init__(self, suite, task_name):
        from libero.libero import benchmark

        self.suite_name = suite
        self.suite = benchmark.get_benchmark_dict()[suite]()
        self.task_index = next(i for i in range(self.suite.n_tasks)
                               if self.suite.get_task(i).name == task_name)
        self.task = self.suite.get_task(self.task_index)
        self.horizon = HORIZONS[suite]
        self.env = None
        self.success = False
        self.reset_actions = []
        self.video = None

    def start_video(self, directory):
        import imageio
        self.video = imageio.get_writer(str(Path(directory) / "video.mp4"), fps=10)

    def record_frame(self, observation):
        self.video.append_data(np.ascontiguousarray(observation["front_rgb"][::-1, ::-1]))

    def finish_video(self):
        if self.video is not None:
            self.video.close()
            self.video = None

    def observation(self, raw):
        return {"front_rgb": raw["agentview_image"], "wrist_rgb": raw["robot0_eye_in_hand_image"],
                "eef_position": raw["robot0_eef_pos"], "eef_quaternion": raw["robot0_eef_quat"],
                "gripper_position": raw["robot0_gripper_qpos"], "instruction": self.task.language}

    @staticmethod
    def state(observation):
        return {name: np.asarray(observation[name]).tolist()
                for name in ("eef_position", "eef_quaternion", "gripper_position")}

    def reset(self, sample):
        from libero.libero import get_libero_path
        from libero.libero.envs import OffScreenRenderEnv

        if sample["taskId"] != self.suite_name + ":" + self.task.name:
            raise ValueError("sample task does not match the selected LIBERO task")
        initial_file = Path(get_libero_path("init_states")) / self.task.problem_folder / self.task.init_states_file
        if file_digest(initial_file) != sample["initialStateDigest"]:
            raise ValueError("initial-state asset differs from the frozen plan")
        initial_states = self.suite.get_task_init_states(self.task_index)
        index = int(sample["initialStateId"])
        if not 0 <= index < len(initial_states):
            raise ValueError("initial-state index is outside the official asset")
        np.random.seed(sample["environmentSeed"])
        bddl = Path(get_libero_path("bddl_files")) / self.task.problem_folder / self.task.bddl_file
        self.env = OffScreenRenderEnv(bddl_file_name=str(bddl), camera_heights=256, camera_widths=256)
        self.env.seed(sample["environmentSeed"])
        self.env.reset()
        raw = self.env.set_init_state(initial_states[index])
        self.reset_actions = []
        for step in range(self.settle_steps):
            action = [0.0] * 6 + [-1.0]
            raw, reward, done, _ = self.env.step(action)
            self.reset_actions.append({"phase": "settle", "step": step, "action": action,
                                       "reward": float(reward), "terminated": bool(done)})
        return self.observation(raw)

    def step(self, action):
        raw, reward, done, _ = self.env.step(action.tolist())
        # This is the native LIBERO done signal used by the selected OpenPI reference runner.
        self.success = bool(done)
        return StepResult(self.observation(raw), float(reward), bool(done), self.success,
                          float(self.env.env.sim.data.time))

    def result(self):
        return {"success": self.success, "source": "LIBERO OffScreenRenderEnv.step.done",
                "taskIndex": self.task_index, "task": self.task.name}

    def close(self):
        if self.env is not None:
            self.env.close()
