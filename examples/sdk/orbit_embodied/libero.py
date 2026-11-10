"""Direct LIBERO environment access; model serving is a separate endpoint."""

from __future__ import annotations

from pathlib import Path
import numpy as np

from .driver import StepResult
from .evidence import file_digest
from .libero_suites import HORIZONS
from .libero_plus import NATIVE_ROOT, classifications, initial_state_path


VIDEO_FPS = 10


class LiberoBenchmark:
    action_size = 7
    settle_steps = 10

    def __init__(self, suite, task_name, *, settle_steps=10):
        from libero.libero import benchmark

        self.suite_name = suite
        self.suite = benchmark.get_benchmark_dict()[suite]()
        self.task_index = next(i for i in range(self.suite.n_tasks)
                               if self.suite.get_task(i).name == task_name)
        self.task = self.suite.get_task(self.task_index)
        self.horizon = HORIZONS[suite]
        if type(settle_steps) is not int or not 0 <= settle_steps < self.horizon:
            raise ValueError("LIBERO settle steps must fit the frozen recipe")
        self.settle_steps = settle_steps
        self.env = None
        self.success = False
        self.reset_actions = []
        self.video = None

    def start_video(self, directory):
        import imageio
        self.video = imageio.get_writer(str(Path(directory) / "video.mp4"), fps=VIDEO_FPS)

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

    def initial_state_file(self, root):
        return root / self.task.problem_folder / self.task.init_states_file

    def initial_state(self, sample, initial_states):
        index = int(sample["initialStateId"])
        if not 0 <= index < len(initial_states):
            raise ValueError("initial-state index is outside the official asset")
        return initial_states[index]

    def reset(self, sample):
        from libero.libero import get_libero_path
        from libero.libero.envs import OffScreenRenderEnv

        if sample["taskId"] != self.suite_name + ":" + self.task.name:
            raise ValueError("sample task does not match the selected LIBERO task")
        initial_file = self.initial_state_file(Path(get_libero_path("init_states")))
        if file_digest(initial_file) != sample["initialStateDigest"]:
            raise ValueError("initial-state asset differs from the frozen plan")
        initial_states = self.suite.get_task_init_states(self.task_index)
        initial_state = self.initial_state(sample, initial_states)
        np.random.seed(sample["environmentSeed"])
        bddl = Path(get_libero_path("bddl_files")) / self.task.problem_folder / self.task.bddl_file
        self.env = OffScreenRenderEnv(bddl_file_name=str(bddl), camera_heights=256, camera_widths=256)
        self.env.seed(sample["environmentSeed"])
        self.env.reset()
        raw = self.env.set_init_state(initial_state)
        return self.settle(raw)

    def settle(self, raw):
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


class LiberoPlusBenchmark(LiberoBenchmark):
    def initial_state_file(self, root):
        if root.resolve() != (Path(NATIVE_ROOT) / "init_files").resolve():
            raise ValueError("LIBERO-Plus must run against its own native simulator checkout")
        return initial_state_path(root, self.suite_name, self.task.name)

    def initial_state(self, sample, initial_states):
        if sample["initialStateId"] != "0":
            raise ValueError("LIBERO-Plus uses exactly one trial per perturbation")
        return super().initial_state(sample, initial_states)

    def result(self):
        row = classifications(Path(NATIVE_ROOT), self.suite_name)[self.task_index]
        if row["name"] != self.task.name:
            raise ValueError("LIBERO-Plus classification differs from the native task")
        return {**super().result(), "source": "LIBERO-Plus OffScreenRenderEnv.step.done",
                "perturbation": row["category"], "difficulty": row["difficulty_level"]}
