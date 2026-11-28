"""Build the Web review from verified native control steps."""

from itertools import groupby
import json
import math
from pathlib import Path

from .eb_navigation import POLICY_VIDEO as EB_NAV_POLICY_VIDEO
from .evidence import write_json
from .libero import VIDEO_FPS as LIBERO_FPS
from .robodojo import VIDEO_FPS as ROBODOJO_FPS
from .robomme import CAMERA_VIDEOS as ROBOMME_CAMERAS, VIDEO_FPS as ROBOMME_FPS
from .robotwin import CAMERA_VIDEOS as ROBOTWIN_CAMERAS, VIDEO_FPS as ROBOTWIN_FPS
from .wire import POLICY_FALLBACKS


LIBERO_STATE = {
    "eef_position": ("eef_x", "eef_y", "eef_z"),
    "eef_quaternion": ("eef_qx", "eef_qy", "eef_qz", "eef_qw"),
    "gripper_position": ("finger_joint1", "finger_joint2"),
}
LIBERO_ACTIONS = ["delta_x", "delta_y", "delta_z", "rotation_x", "rotation_y", "rotation_z", "gripper"]
# Recorders without a description use these known paths and rates.
VIDEOS = {
    "libero": ({"front_rgb": "video.mp4"}, LIBERO_FPS),
    "robotwin": (ROBOTWIN_CAMERAS, ROBOTWIN_FPS),
    "robomme": (ROBOMME_CAMERAS, ROBOMME_FPS),
    "robodojo": ({"cam_head": "video.mp4"}, ROBODOJO_FPS),
    "robolab": ({"front_rgb": "video.mp4"}, None),
    "chores": ({"raw_navigation_camera": "video.mp4", "raw_manipulation_camera": "arm.mp4"}, None),
    "hssd-ov": ({"rgb": "video.mp4"}, None),
    "eb-navigation": ({"front_rgb": "video.mp4", "overhead_rgb": "overhead.mp4",
                       "navigation_views": EB_NAV_POLICY_VIDEO}, None),
}
PREVIEW_LIMIT = 2 * 1024 * 1024


def rounded(value):
    """Six significant digits: enough to read a curve at half the text of a full float."""
    return float(format(value, ".6g"))


def encoded_size(value):
    return len(json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False,
                          separators=(",", ":")).encode("utf-8")) + 1


def sampled_indexes(count, target, required=()):
    indexes = {0, count - 1, *required}
    indexes.update(round(index * (count - 1) / (target - 1)) for index in range(target))
    return sorted(indexes)


def bound_preview(trace):
    """Bound the actual UTF-8 file, retaining original times, endpoints and the slowest call."""
    if encoded_size(trace) <= PREVIEW_LIMIT and len(trace["samples"]) <= 100_000:
        return
    trace["completeness"] = "truncated"
    samples, chunks = trace["samples"], trace["chunks"]
    slowest = max(range(len(chunks)), key=lambda index: chunks[index]["inferSeconds"])
    # Keep every call unless call metadata alone would crowd out the curves.
    if len(chunks) > 100_000 or encoded_size(chunks) > PREVIEW_LIMIT // 2:
        target = max(2, min(99_997, int(len(chunks) * PREVIEW_LIMIT / (2 * encoded_size(chunks)))))
        trace["chunks"] = [chunks[index] for index in sampled_indexes(len(chunks), target, [slowest])]
    required = [index for index, sample in enumerate(samples)
                if sample["time"] in (chunks[slowest]["start"], chunks[slowest]["end"])]
    maps = [camera["video"]["timeMap"] for camera in trace["cameras"]]
    target = min(len(samples), 99_996)
    while True:
        indexes = sampled_indexes(len(samples), max(2, target), required)
        trace["samples"] = [samples[index] for index in indexes]
        for camera, mapping in zip(trace["cameras"], maps):
            camera["video"]["timeMap"] = [mapping[index] for index in indexes]
        size = encoded_size(trace)
        if size <= PREVIEW_LIMIT:
            return
        if target <= 2:
            raise ValueError("native trajectory metadata exceeds the preview limit")
        target = max(2, min(target - 1, int(target * PREVIEW_LIMIT / size * 0.8)))


def positive_rate(value):
    return type(value) in (int, float) and 0 < value < math.inf


def read_recording(directory):
    path = directory / "recording.json"
    if path.is_symlink():
        return None
    try:
        recording = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(recording, dict) or recording.get("version") != 1:
        return None
    camera, name = recording.get("camera"), recording.get("path")
    frames = recording.get("frames")
    if (not isinstance(camera, str) or not 0 < len(camera) <= 100
            or not isinstance(name, str) or name != Path(name).name or "\\" in name
            or Path(name).suffix != ".mp4" or type(frames) is not int or frames < 0
            or not positive_rate(recording.get("fps"))):
        return None
    return recording


def stopped_at_step_limit(last, horizon, kind, success):
    reached_horizon = last["step"] + 1 >= horizon
    if reached_horizon and not last["terminated"]:
        return True
    truncated = last["state"].get("truncated")
    if isinstance(truncated, bool):
        return truncated
    # Older control records can omit the explicit stop cause.
    if kind == "colosseum-v2":
        # Verify accepts only complete horizons, which the native evaluator truncates.
        return reached_horizon
    # Verify accepts an unfinished CALVIN sequence only after a subtask reaches its step limit.
    return not success and (kind == "calvin" or reached_horizon)


def write_trajectory(directory, destination, result, expected, *, kind):
    """Write a review index from a verified episode with a known control rate."""
    directory = Path(directory)
    recording = read_recording(directory)
    videos, fps = VIDEOS.get(kind, ({}, None))
    reference = expected.get("reference", {})
    environment = reference.get("environment", {})
    task = expected.get("sample", {}).get("taskId")
    if recording is not None:
        fps = recording["fps"]
    elif fps is None:
        fps = environment.get("controlRates", {}).get(
            task, environment.get("controlHz", reference.get("parameters", {}).get("controlHz")))
    if fps is None and kind not in VIDEOS:
        return
    if not positive_rate(fps):
        raise ValueError("video frame rate must be positive and finite")

    with (directory / "actions.jsonl").open() as log:
        controls = [row for row in map(json.loads, log) if row["phase"] == "control"]
    if not controls:
        return

    if recording is not None:
        videos = {recording["camera"]: recording["path"]} if recording["frames"] == len(controls) else {}
    if kind == "libero":
        action_names, state_fields = LIBERO_ACTIONS, LIBERO_STATE
    else:
        # The benchmark profile names the action channels and those of each state vector it orders.
        profile = expected["binding"]["benchmarkProfile"]
        action_names = profile["action"].get("order")
        if action_names is None:
            action_names = [f"action {index + 1}" for index in range(len(controls[0]["action"]))]
        state_fields = {field: descriptor["order"] for field, descriptor in profile["observations"].items()
                        if field in controls[0]["state"] and "order" in descriptor}
    initial = json.loads((directory / "initial-state.json").read_text())["state"]
    recorded = initial.get("instruction")
    goal = (recorded if isinstance(recorded, str)
            else environment.get("instructions", {}).get(task) or task)
    state_names = [name for names in state_fields.values() for name in names]
    horizon = json.loads((directory / "contract.json").read_text())["horizon"]
    step_limit_reached = stopped_at_step_limit(controls[-1], horizon, kind, result["success"])

    def at(step):
        return round(step / fps, 6)

    samples, instruction_changes = [], []
    instruction = initial.get("instruction")
    for row in controls:
        time = at(row["step"])
        if isinstance(instruction, str) and (
                not instruction_changes or instruction_changes[-1]["text"] != instruction):
            instruction_changes.append({"time": time, "text": instruction})
        # The state in this row follows the action, so its instruction belongs to the next frame.
        instruction = row["state"].get("instruction")
        action = row["action"]
        state = []
        for field, names in state_fields.items():
            values = row["state"][field]
            if len(values) != len(names):
                raise ValueError("recorded state does not match its channel names")
            state.extend(values)
        if len(action) != len(action_names):
            raise ValueError("recorded action does not match its channel names")
        samples.append({"time": time, "action": [rounded(value) for value in action],
                        "proprio": [rounded(value) for value in state], "reward": rounded(row["reward"]),
                        "terminated": row["terminated"] and not step_limit_reached,
                        "truncated": row is controls[-1] and step_limit_reached})

    chunks = []
    for index, group in groupby(controls, key=lambda row: row["chunk"]):
        rows = list(group)
        timing = json.loads((directory / "chunks" / (str(index) + ".json")).read_text())
        chunk = {"label": str(index + 1), "start": at(rows[0]["step"]), "end": at(rows[-1]["step"]),
                 "inferSeconds": rounded(timing["inferSeconds"])}
        fallback = timing.get("fallback")
        if fallback in POLICY_FALLBACKS:
            chunk["fallback"] = fallback
        elif kind == "eb-navigation":
            chunk["fallback"] = "unrecorded"
        chunks.append(chunk)

    cameras = []
    # With no recording errors, frame i was captured just before control step i.
    if not (directory / "media-status.json").exists() and not any(
            issue.startswith("optional video") for issue in result["issues"]):
        prefix = "episodes/" + directory.name if expected.get("batch") else "episode"
        # Seek inside each frame, away from timestamp rounding at its boundary.
        time_map = [{"time": at(row["step"]), "videoTime": at(row["step"] + 0.5)} for row in controls]
        for camera, name in videos.items():
            path = directory / name
            if not path.is_symlink() and path.is_file() and path.stat().st_size:
                cameras.append({"name": camera, "video": {"path": prefix + "/" + name, "timeMap": time_map},
                                "source": "render"})

    trace = {"version": 1, "kind": "episode", "goal": goal,
             "actionNames": action_names, "proprioNames": state_names, "samples": samples,
             "chunks": chunks, "cameras": cameras, "producer": "verifier",
             "completeness": "environment-only", "mediaPhase": "solve", "frameBeforeAction": True}
    if instruction_changes and (len(instruction_changes) > 1 or not goal
                                or instruction_changes[0]["text"] != goal):
        trace["instructionChanges"] = instruction_changes
    bound_preview(trace)
    write_json(destination, trace, compact=True)
