"""Native EB-Navigation episodes and CPU checks for the release's success rule."""

from contextlib import ExitStack
import json
import math
from pathlib import Path

from .binding import digest, reset_seed, seed_asset


SPLITS = ("base", "common_sense", "complex_instruction", "visual_appearance", "long_horizon")
DATASETS = Path("embodiedbench/envs/eb_navigation/datasets")
HORIZON = 20
RENDER_SIZE = 500
VIDEO_FPS = 5
POLICY_VIDEO = "navigation-views.mp4"
ACTION_NAMES = ("MoveAhead", "MoveBack", "MoveRight", "MoveLeft", "RotateRight", "RotateLeft", "LookUp", "LookDown")


def read_catalog(directory):
    catalog = {}
    for split in SPLITS:
        tasks = json.loads((directory / (split + ".json")).read_text())["tasks"]
        if len(tasks) != 60:
            raise ValueError("expected 60 official EB-Navigation episodes in " + split)
        for index, row in enumerate(tasks):
            catalog[f"{split}:{index + 1:02}"] = row
    return catalog


def semantic_profile():
    observations = {
        "navigation_views": {"semantic": "rgb", "dtype": "uint8", "shape": [RENDER_SIZE, RENDER_SIZE * 2, 3],
                             "camera": "eb-navigation-projected-overhead-then-front", "layout": "HWC"},
        "instruction": {"semantic": "language_instruction", "dtype": "string", "shape": []},
        "previous_feedback": {"semantic": "previous_eb_navigation_feedback", "dtype": "string", "shape": []},
        "previous_action": {"semantic": "previous_eb_navigation_action_id", "dtype": "int32", "shape": [1]},
        "navigation_pose": {"semantic": "agent_pose", "dtype": "float64", "shape": [4],
                            "frame": "ai2thor-world", "order": ["x_m", "z_m", "yaw_deg", "pitch_deg"]},
    }
    return {"id": "eb-navigation-projected/1", "observations": observations,
            "action": {"semantic": "discrete_navigation_action_id", "shape": [1],
                       "controller": "eb-navigation-8-actions/1", "frame": "agent", "unit": "index",
                       "rotation": "90-deg-yaw-30-deg-pitch", "gripper": "none", "order": ["action_id"]}}


def action_id(action):
    from .driver import EpisodeFailure

    value, = action
    if not math.isfinite(value) or int(value) != value or not 0 <= value < len(ACTION_NAMES):
        raise EpisodeFailure("policy_act", "expected one EB-Navigation action ID in [0, 7]")
    return int(value)


def distance_to_target(position, target):
    dx, dz = position[0] - target["x"], position[1] - target["z"]
    return math.sqrt(dx * dx + dz * dz)


class EBNavigationBenchmark:
    action_size = 1
    settle_steps = 0
    horizon = HORIZON

    def __init__(self, reference, task):
        self.reference = reference
        self.task = task
        self.native = None

    def start_video(self, directory):
        import imageio.v2 as imageio

        with ExitStack() as stack:
            self.video_front = stack.enter_context(imageio.get_writer(
                str(Path(directory) / "video.mp4"), fps=VIDEO_FPS, macro_block_size=2))
            self.video_top = stack.enter_context(imageio.get_writer(
                str(Path(directory) / "overhead.mp4"), fps=VIDEO_FPS, macro_block_size=2))
            self.video_policy = stack.enter_context(imageio.get_writer(
                str(Path(directory) / POLICY_VIDEO), fps=VIDEO_FPS, macro_block_size=2))
            self.videos = stack.pop_all()

    def record_frame(self, observation):
        import numpy as np

        self.video_front.append_data(np.asarray(observation["fv_rgb"]))
        self.video_top.append_data(np.asarray(observation["bev_rgb"]))
        self.video_policy.append_data(observation["navigation_views"])

    def finish_video(self):
        self.videos.close()

    def reset(self, sample):
        from envs.EBNavEnv import EBNavigationEnv
        from ActionMarker.ActionMarker import ActionMarker

        split, number = self.task.split(":")
        reset_seed(sample, self.reference)
        row = self.reference["environment"]["catalog"][self.task]
        if sample["initialStateDigest"] != digest(row) or sample["initialStateDigest"] != seed_asset(self.reference, self.task):
            raise ValueError("sample does not match the official EB-Navigation episode")

        class Native(EBNavigationEnv):
            def save_episode_log_per_step(self, flag):
                # Orbit seals the native feedback with its actual action sequence.
                pass

        self.native = Native(eval_set=split, selected_indexes=[int(number) - 1], fov=100, multiview=True,
                             resolution=RENDER_SIZE, full_config={"random_reset": False, "nav_line": True})
        if self.native.dataset != [row] or self.native._max_episode_steps != self.horizon:
            raise ValueError("installed EB-Navigation catalog or horizon differs from the registration")
        self.marker = ActionMarker(env=self.native.env,
                                   config={"img_width": RENDER_SIZE, "img_height": RENDER_SIZE})
        observation = self.native.reset()
        if not self.native.env.last_event.metadata["lastActionSuccess"]:
            raise ValueError("AI2-THOR rejected the official EB-Navigation start pose")
        self.info = None
        self.reward = 0.0
        return self.observation(observation, -1, "")

    def observation(self, raw, previous, feedback):
        import numpy as np
        from PIL import Image

        event = self.native.env.last_event
        agent = event.metadata["agent"]
        projected = self.native.add_marks_on_obs({name: image.copy() for name, image in raw.items()})
        front, top = self.marker.draw_action(list(range(len(ACTION_NAMES))), projected, agent_mark=True, align=True)
        views = Image.new("RGB", (RENDER_SIZE * 2, RENDER_SIZE))
        views.paste(top, (0, 0))
        views.paste(front, (RENDER_SIZE, 0))
        return {**raw, "navigation_views": np.asarray(views), "instruction": self.native.episode_language_instruction,
                "previous_feedback": feedback, "previous_action": np.asarray([previous], dtype=np.int32),
                "navigation_pose": [agent["position"]["x"], agent["position"]["z"],
                                    agent["rotation"]["y"], agent["cameraHorizon"]],
                "actionSucceeded": bool(event.metadata["lastActionSuccess"])}

    def state(self, observation):
        return {"instruction": observation["instruction"], "navigation_pose": observation["navigation_pose"],
                "actionSucceeded": observation["actionSucceeded"], "feedback": observation["previous_feedback"]}

    def step(self, action):
        from .driver import StepResult

        index = action_id(action)
        raw, reward, done, info = self.native.step(index, {}, 1)
        event = self.native.env.last_event
        if event.metadata["lastAction"] != ACTION_NAMES[index] or info["action_id"] != index:
            raise ValueError("AI2-THOR executed a different action than requested")
        self.info = info
        self.reward = float(reward)
        observation = self.observation(raw, index, info["env_feedback"])
        return StepResult(observation, self.reward, bool(done), bool(info["task_success"]), native_action=[index],
                          native_done=bool(done))

    def result(self):
        return {"success": bool(self.info["task_success"]), "distanceToTarget": self.info["distance"]}

    def close(self):
        if self.native is not None:
            self.native.close()


def verify_navigation(reference, sample, initial, controls, result):
    task = sample["taskId"]
    row = reference["environment"]["catalog"][task]
    reset_seed(sample, reference)
    if sample["initialStateDigest"] != digest(row):
        raise ValueError("EB-Navigation sample has a mismatched official start or goal")
    start = row["agentPose"]
    position = initial["navigation_pose"]
    start_xz = (start["position"]["x"], start["position"]["z"])
    if (len(position) != 4 or not all(math.isfinite(value) for value in position)
            or not all(math.isclose(a, b, abs_tol=1e-3) for a, b in zip(position[:2], start_xz))):
        raise ValueError("EB-Navigation evidence has an unexpected start pose")
    if (abs((position[2] - start["rotation"] + 180) % 360 - 180) > 1e-3
            or abs((position[3] - start["horizon"] + 180) % 360 - 180) > 1e-3):
        raise ValueError("EB-Navigation evidence has an unexpected start orientation")
    for step in controls:
        state = step["state"]
        pose = state["navigation_pose"]
        if len(pose) != 4 or not all(math.isfinite(value) for value in pose):
            raise ValueError("invalid native navigation pose")
        distance = distance_to_target(pose, row["target_position"])
        success = distance <= 1
        done = success or step["step"] + 1 == HORIZON
        if (state["instruction"] != row["instruction"] or step["nativeAction"] != [action_id(step["action"])]
                or step["reward"] != int(success) or step["nativeSuccess"] is not success
                or step["nativeDone"] is not done or step["terminated"] is not done
                or (done and step is not controls[-1])):
            raise ValueError("EB-Navigation action, reward or stopping evidence differs from the native rule")
    if (initial["instruction"] != row["instruction"] or not done
            or result["native"]["success"] is not success
            or not math.isclose(result["native"]["distanceToTarget"], distance, abs_tol=1e-9)):
        raise ValueError("EB-Navigation result differs from the verified native trace")
