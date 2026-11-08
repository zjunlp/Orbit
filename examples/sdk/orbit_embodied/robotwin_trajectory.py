"""Build the Web review from a verified RoboTwin episode."""

from itertools import groupby
import json
from pathlib import Path

from .evidence import write_json
from .robotwin import CAMERA_VIDEOS, VIDEO_FPS


def write_trajectory(directory, destination, result, expected):
    directory = Path(directory)
    with (directory / "actions.jsonl").open() as log:
        controls = [row for row in map(json.loads, log) if row["phase"] == "control"]
    if not controls:
        return

    profile = expected["binding"]["benchmarkProfile"]
    action_names = profile["action"]["order"]
    joint_names = profile["observations"]["joint_state"]["order"]
    initial = json.loads((directory / "initial-state.json").read_text())["state"]
    samples = []
    reached_horizon = result["native"]["termination"] == "horizon"
    for row in controls:
        action, joints = row["action"], row["state"]["joint_state"]
        if len(action) != len(action_names) or len(joints) != len(joint_names):
            raise ValueError("RoboTwin trajectory does not match the frozen channels")
        samples.append({"time": row["step"] / VIDEO_FPS, "action": action, "proprio": joints,
                        "reward": row["reward"], "terminated": row["terminated"] and not reached_horizon,
                        "truncated": row["terminated"] and reached_horizon})

    chunks = []
    for index, group in groupby(controls, key=lambda row: row["chunk"]):
        rows = list(group)
        timing = json.loads((directory / "chunks" / (str(index) + ".json")).read_text())
        chunks.append({"label": str(index + 1), "start": rows[0]["step"] / VIDEO_FPS,
                       "end": rows[-1]["step"] / VIDEO_FPS, "inferSeconds": timing["inferSeconds"]})

    cameras = []
    # With no recording errors, frame i was captured just before control step i.
    if not (directory / "media-status.json").exists() and not any(
            issue.startswith("optional video") for issue in result["issues"]):
        prefix = "episodes/" + directory.name if expected.get("batch") else "episode"
        # Seek inside each frame, away from timestamp rounding at its boundary.
        time_map = [{"time": sample["time"], "videoTime": sample["time"] + 0.5 / VIDEO_FPS}
                    for sample in samples]
        for camera, name in CAMERA_VIDEOS.items():
            path = directory / name
            if not path.is_symlink() and path.is_file() and path.stat().st_size:
                cameras.append({"name": camera, "video": {"path": prefix + "/" + name, "timeMap": time_map},
                                "source": "render"})

    trace = {"version": 1, "kind": "episode", "goal": initial["instruction"],
             "actionNames": action_names, "proprioNames": joint_names, "samples": samples,
             "chunks": chunks, "cameras": cameras, "producer": "verifier",
             "completeness": "environment-only", "mediaPhase": "solve", "frameBeforeAction": True}
    if len(json.dumps(trace, ensure_ascii=False, allow_nan=False).encode("utf-8")) >= 2 * 1024 * 1024:
        raise ValueError("RoboTwin trajectory exceeds the preview limit")
    write_json(destination, trace)
