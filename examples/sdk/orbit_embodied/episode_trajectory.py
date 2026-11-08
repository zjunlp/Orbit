"""Build the Web review from verified native control steps."""

from itertools import groupby
import json
from pathlib import Path

from .evidence import write_json
from .libero import VIDEO_FPS as LIBERO_FPS
from .robotwin import CAMERA_VIDEOS as ROBOTWIN_CAMERAS, VIDEO_FPS as ROBOTWIN_FPS


LIBERO_CAMERAS = {"front_rgb": "video.mp4"}
LIBERO_STATE = {
    "eef_position": ("eef_x", "eef_y", "eef_z"),
    "eef_quaternion": ("eef_qx", "eef_qy", "eef_qz", "eef_qw"),
    "gripper_position": ("finger_joint1", "finger_joint2"),
}
LIBERO_ACTIONS = ["delta_x", "delta_y", "delta_z", "rotation_x", "rotation_y", "rotation_z", "gripper"]


def write_trajectory(directory, destination, result, expected, *, kind):
    directory = Path(directory)
    with (directory / "actions.jsonl").open() as log:
        controls = [row for row in map(json.loads, log) if row["phase"] == "control"]
    if not controls:
        return

    if kind == "robotwin":
        profile = expected["binding"]["benchmarkProfile"]
        action_names = profile["action"]["order"]
        state_fields = {"joint_state": profile["observations"]["joint_state"]["order"]}
        initial = json.loads((directory / "initial-state.json").read_text())["state"]
        goal = initial["instruction"]
        videos, fps = ROBOTWIN_CAMERAS, ROBOTWIN_FPS
    else:
        action_names, state_fields = LIBERO_ACTIONS, LIBERO_STATE
        goal = expected["sample"]["taskId"]
        videos, fps = LIBERO_CAMERAS, LIBERO_FPS
    state_names = [name for names in state_fields.values() for name in names]
    samples = []
    reached_horizon = not result["success"]
    for row in controls:
        action = row["action"]
        state = []
        for field, names in state_fields.items():
            values = row["state"][field]
            if len(values) != len(names):
                raise ValueError("recorded state does not match its channel names")
            state.extend(values)
        if len(action) != len(action_names):
            raise ValueError("recorded action does not match its channel names")
        samples.append({"time": row["step"] / fps, "action": action, "proprio": state,
                        "reward": row["reward"], "terminated": row["terminated"] and not reached_horizon,
                        "truncated": row is controls[-1] and reached_horizon})

    chunks = []
    for index, group in groupby(controls, key=lambda row: row["chunk"]):
        rows = list(group)
        timing = json.loads((directory / "chunks" / (str(index) + ".json")).read_text())
        chunks.append({"label": str(index + 1), "start": rows[0]["step"] / fps,
                       "end": rows[-1]["step"] / fps, "inferSeconds": timing["inferSeconds"]})

    cameras = []
    # With no recording errors, frame i was captured just before control step i.
    if not (directory / "media-status.json").exists() and not any(
            issue.startswith("optional video") for issue in result["issues"]):
        prefix = "episodes/" + directory.name if expected.get("batch") else "episode"
        # Seek inside each frame, away from timestamp rounding at its boundary.
        time_map = [{"time": sample["time"], "videoTime": sample["time"] + 0.5 / fps}
                    for sample in samples]
        for camera, name in videos.items():
            path = directory / name
            if not path.is_symlink() and path.is_file() and path.stat().st_size:
                cameras.append({"name": camera, "video": {"path": prefix + "/" + name, "timeMap": time_map},
                                "source": "render"})

    trace = {"version": 1, "kind": "episode", "goal": goal,
             "actionNames": action_names, "proprioNames": state_names, "samples": samples,
             "chunks": chunks, "cameras": cameras, "producer": "verifier",
             "completeness": "environment-only", "mediaPhase": "solve", "frameBeforeAction": True}
    if len(json.dumps(trace, ensure_ascii=False, allow_nan=False).encode("utf-8")) >= 2 * 1024 * 1024:
        raise ValueError("native trajectory exceeds the preview limit")
    write_json(destination, trace)
