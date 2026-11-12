"""Build the Web review from verified native control steps."""

from itertools import groupby
import json
import math
from pathlib import Path

from .evidence import write_json
from .libero import VIDEO_FPS as LIBERO_FPS
from .robodojo import VIDEO_FPS as ROBODOJO_FPS
from .robotwin import CAMERA_VIDEOS as ROBOTWIN_CAMERAS, VIDEO_FPS as ROBOTWIN_FPS


LIBERO_STATE = {
    "eef_position": ("eef_x", "eef_y", "eef_z"),
    "eef_quaternion": ("eef_qx", "eef_qy", "eef_qz", "eef_qw"),
    "gripper_position": ("finger_joint1", "finger_joint2"),
}
LIBERO_ACTIONS = ["delta_x", "delta_y", "delta_z", "rotation_x", "rotation_y", "rotation_z", "gripper"]
# Saved videos per environment kind and their frame rate; None records at the reference control rate.
VIDEOS = {
    "libero": ({"front_rgb": "video.mp4"}, LIBERO_FPS),
    "robotwin": (ROBOTWIN_CAMERAS, ROBOTWIN_FPS),
    "robodojo": ({"cam_head": "video.mp4"}, ROBODOJO_FPS),
    "robolab": ({"front_rgb": "video.mp4"}, None),
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


def write_trajectory(directory, destination, result, expected, *, kind):
    """Write the episode index of a verified episode; kinds without a known recording are skipped."""
    if kind not in VIDEOS:
        return
    directory = Path(directory)
    with (directory / "actions.jsonl").open() as log:
        controls = [row for row in map(json.loads, log) if row["phase"] == "control"]
    if not controls:
        return

    videos, fps = VIDEOS[kind]
    environment = expected.get("reference", {}).get("environment", {})
    task = expected["sample"]["taskId"]
    if fps is None:
        fps = environment["controlHz"]
    if type(fps) not in (int, float) or not math.isfinite(fps) or fps <= 0:
        raise ValueError("video frame rate must be positive and finite")
    if kind == "libero":
        action_names, state_fields, goal = LIBERO_ACTIONS, LIBERO_STATE, task
    else:
        # The benchmark profile names the action channels and those of each state vector it orders.
        profile = expected["binding"]["benchmarkProfile"]
        action_names = profile["action"]["order"]
        state_fields = {field: descriptor["order"] for field, descriptor in profile["observations"].items()
                        if field in controls[0]["state"] and "order" in descriptor}
        initial = json.loads((directory / "initial-state.json").read_text())["state"]
        goal = initial.get("instruction") or environment.get("instructions", {}).get(task) or task
    state_names = [name for names in state_fields.values() for name in names]
    horizon = json.loads((directory / "contract.json").read_text())["horizon"]
    # A failure on the last allowed step ran out of time; an earlier one was ended by the environment.
    reached_horizon = not result["success"] and controls[-1]["step"] + 1 >= horizon

    def at(step):
        return round(step / fps, 6)

    samples = []
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
        samples.append({"time": at(row["step"]), "action": [rounded(value) for value in action],
                        "proprio": [rounded(value) for value in state], "reward": rounded(row["reward"]),
                        "terminated": row["terminated"] and not reached_horizon,
                        "truncated": row is controls[-1] and reached_horizon})

    chunks = []
    for index, group in groupby(controls, key=lambda row: row["chunk"]):
        rows = list(group)
        timing = json.loads((directory / "chunks" / (str(index) + ".json")).read_text())
        chunks.append({"label": str(index + 1), "start": at(rows[0]["step"]), "end": at(rows[-1]["step"]),
                       "inferSeconds": rounded(timing["inferSeconds"])})

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
    bound_preview(trace)
    write_json(destination, trace, compact=True)
