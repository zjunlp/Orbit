"""Native RoboMME public-test catalog, joint-angle rollout, and scoring evidence."""

from contextlib import ExitStack
import json

from .binding import reset_seed, seed_asset


HORIZON = 1300
VIDEO_FPS = 20
CAMERAS = {"front_rgb": "front_rgb_list", "wrist_rgb": "wrist_rgb_list"}
CAMERA_VIDEOS = {key: f"{key}.mp4" for key in CAMERAS}
SUITES = {
    "counting": ("PickXtimes", "StopCube", "SwingXtimes", "BinFill"),
    "permanence": ("VideoUnmaskSwap", "VideoUnmask", "ButtonUnmaskSwap", "ButtonUnmask"),
    "reference": ("VideoRepick", "VideoPlaceButton", "VideoPlaceOrder", "PickHighlight"),
    "imitation": ("InsertPeg", "MoveCube", "PatternLock", "RouteStick"),
}
NATIVE_STATUSES = ("ongoing", "success", "fail", "timeout", "error")


def test_catalog(root):
    """Read the complete upstream public test metadata without importing the simulator."""
    catalog = {}
    for tasks in SUITES.values():
        for task in tasks:
            filename = root / "src/robomme/env_metadata/test" / f"record_dataset_{task}_metadata.json"
            metadata = json.loads(filename.read_text())
            rows = metadata["records"]
            if (metadata["env_id"] != task or metadata["record_count"] != 50 or len(rows) != 50
                    or {row["episode"] for row in rows} != set(range(50))):
                raise ValueError("RoboMME public episode catalog is incomplete for " + task)
            for row in rows:
                if (row["task"] != task or type(row["seed"]) is not int or not 0 <= row["seed"] < 2 ** 32
                        or row["difficulty"] not in ("easy", "medium", "hard")):
                    raise ValueError("invalid RoboMME initial state for " + task)
            catalog[task] = [{field: row[field] for field in ("seed", "difficulty")}
                             for row in sorted(rows, key=lambda row: row["episode"])]
    return catalog


class RoboMMEBenchmark:
    action_size = 8
    horizon = HORIZON
    settle_steps = 0

    def __init__(self, reference, task):
        self.reference, self.task = reference, task
        self.env = None
        self.video_stack = ExitStack()
        self.videos = {}
        self.directory = None

    def reset(self, sample):
        import robomme.robomme_env  # Registers native tasks.
        from robomme.env_record_wrapper import BenchmarkEnvBuilder

        if sample["taskId"] != self.task or sample["initialStateDigest"] != seed_asset(self.reference, self.task):
            raise ValueError("RoboMME sample differs from the frozen reset catalog")
        reset_seed(sample, self.reference)
        self.episode = int(sample["initialStateId"])
        self.initial = self.reference["environment"]["testEpisodes"][self.task][self.episode]
        builder = BenchmarkEnvBuilder(env_id=self.task, dataset="test", action_space="joint_angle",
                                      gui_render=False, max_steps=self.horizon)
        if (builder.get_episode_num() != 50 or builder.resolve_episode(self.episode) !=
                (self.initial["seed"], self.initial["difficulty"])):
            raise ValueError("native RoboMME episode differs from the frozen test metadata")
        self.env = builder.make_env_for_episode(self.episode)
        raw, info = self.env.reset()
        task_goal = info["task_goal"]
        self.instruction = task_goal[0] if isinstance(task_goal, list) else task_goal
        self.steps, self.status, self.done = 0, "ongoing", False
        self.observation = self.observations(raw)
        self.demo_frames = len(raw["front_rgb_list"]) - 1
        if self.directory is not None and self.demo_frames:
            self.record_demonstration(raw)
        return self.observation

    def observations(self, raw):
        import numpy as np

        return {
            **{key: raw[native][-1] for key, native in CAMERAS.items()},
            "joint_state": np.concatenate((raw["joint_state_list"][-1], raw["gripper_state_list"][-1][:1]),
                                          dtype=np.float32),
            "instruction": self.instruction,
        }

    def state(self, observation):
        return {"joint_state": observation["joint_state"].tolist(), "instruction": self.instruction,
                "episode": self.episode, **self.initial, "status": self.status,
                "demonstrationFrames": self.demo_frames}

    def step(self, action):
        import numpy as np

        from .driver import EpisodeFailure, StepResult

        command = np.asarray(action, dtype=np.float32)
        raw, _, terminated, truncated, info = self.env.step(command)
        if info["status"] == "error":
            exception = info.get("exception_type", "unknown exception")
            message = info.get("error_message", "no native details")
            raise EpisodeFailure("env_step", f"RoboMME simulator error ({exception}): {message}")
        self.steps += 1
        self.status = info["status"]
        self.done = bool(terminated or truncated)
        if self.status not in NATIVE_STATUSES or (self.status == "ongoing") == self.done:
            raise ValueError("RoboMME native status contradicts its step result")
        self.observation = self.observations(raw)
        success = self.status == "success"
        at_limit = self.steps == self.horizon
        return StepResult(self.observation, float(success), self.done or at_limit, success,
                          native_action=command.tolist(), native_done=self.done,
                          truncated=self.status == "timeout" or (not self.done and at_limit))

    def result(self):
        return {"source": "RoboMME native status", "task": self.task, "episode": self.episode,
                **self.initial, "nativeStatus": self.status, "demonstrationFrames": self.demo_frames,
                "termination": self.status if self.done else "horizon", "success": self.status == "success"}

    def start_video(self, directory):
        import imageio

        self.directory = directory
        with ExitStack() as stack:
            self.videos = {key: stack.enter_context(imageio.get_writer(str(directory / name), fps=VIDEO_FPS))
                           for key, name in CAMERA_VIDEOS.items()}
            self.video_stack = stack.pop_all()

    def record_demonstration(self, raw):
        import imageio

        for key, native in CAMERAS.items():
            try:
                with imageio.get_writer(str(self.directory / f"{key}_demonstration.mp4"), fps=VIDEO_FPS) as writer:
                    for frame in raw[native][:-1]:
                        writer.append_data(frame)
            except (OSError, RuntimeError, ValueError) as exc:
                self.media_issue = "RoboMME demonstration video: " + str(exc)

    def record_frame(self, observation):
        for key, writer in self.videos.items():
            writer.append_data(observation[key])

    def finish_video(self):
        self.video_stack.close()
        if hasattr(self, "media_issue"):
            raise OSError(self.media_issue)

    def close(self):
        if self.env is not None:
            self.env.close()
            self.env = None


def verify_robomme(reference, sample, initial, controls, result):
    import numpy as np

    episode = int(sample["initialStateId"])
    frozen = reference["environment"]["testEpisodes"][sample["taskId"]][episode]
    native = result["native"]
    demo = initial["demonstrationFrames"]
    if (native["source"] != "RoboMME native status" or native["task"] != sample["taskId"]
            or type(demo) is not int or demo < 0
            or native["demonstrationFrames"] != demo or initial["status"] != "ongoing"):
        raise ValueError("invalid RoboMME result or demonstration evidence")
    expected = {"episode": episode, **frozen}
    for state in (native, initial, *(row["state"] for row in controls)):
        if any(state.get(key) != value for key, value in expected.items()):
            raise ValueError("RoboMME evidence differs from the frozen test episode")
    for index, row in enumerate(controls, 1):
        state = row["state"]
        status = state["status"]
        done = status != "ongoing"
        success = status == "success"
        if (status not in NATIVE_STATUSES or state["instruction"] != initial["instruction"]
                or state["demonstrationFrames"] != demo or row["nativeDone"] is not done
                or row["nativeSuccess"] is not success or row["reward"] != float(success)
                or row["terminated"] is not (done or index == HORIZON)
                or row["nativeAction"] != np.asarray(row["action"], dtype=np.float32).tolist()):
            raise ValueError("RoboMME control evidence contradicts the native protocol")
    last = controls[-1]["state"]["status"]
    if (last != native["nativeStatus"] or native["termination"] != ("horizon" if last == "ongoing" else last)
            or result["success"] is not (last == "success")):
        raise ValueError("RoboMME terminal status differs from the scoring evidence")
