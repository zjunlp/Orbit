"""Episode index checks on synthetic control logs and the checked-in benchmark profiles; no simulator."""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from orbit_embodied import episode_trajectory
from orbit_embodied.eb_navigation import POLICY_VIDEO, semantic_profile
from orbit_embodied.episode_trajectory import write_trajectory
from orbit_embodied.evidence import write_json

PROFILES = Path(__file__).resolve().parents[2] / "bench-adapters/embodied/profiles"


def expectation(profile, task, **extra):
    reference = json.loads((PROFILES / profile).read_text())
    return {"sample": {"taskId": task}, "reference": reference,
            "binding": {"benchmarkProfile": reference["benchmarkProfile"]}, **extra}


def episode(directory, states, *, action, horizon, initial, video=True, replan=1):
    """Synthetic verified control logs; no native simulator or video encoder is involved."""
    rows = [{"phase": "control", "step": step, "chunk": step // replan, "action": action, "reward": 0.0,
             "terminated": step == len(states) - 1, "state": state} for step, state in enumerate(states)]
    (directory / "actions.jsonl").write_text("\n".join(map(json.dumps, rows)))
    (directory / "chunks").mkdir()
    for chunk in range((len(states) + replan - 1) // replan):
        (directory / "chunks" / (str(chunk) + ".json")).write_text('{"inferSeconds":0.123456789}')
    write_json(directory / "contract.json", {"horizon": horizon})
    write_json(directory / "initial-state.json", {"state": initial})
    if video:
        (directory / "video.mp4").write_bytes(b"synthetic")
    return directory / "orbit-trajectory.json"


class EpisodeTrajectoryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name) / "trial.attempt"
        self.directory.mkdir()

    def test_robodojo_names_channels_from_the_profile_and_skips_unnamed_state(self):
        joints = [0.1 * index for index in range(14)]
        state = {"layout": {"id": 0}, "nativeStepCount": 1, "nativeEnded": False, "processScore": None,
                 "joint_state": joints, "left_ee_pose": [0.0] * 7, "right_ee_pose": [0.0] * 7,
                 "instruction": "Stack the bowls."}
        output = episode(self.directory, [state, state], action=[0.5] * 14, horizon=2, initial=state)
        write_trajectory(self.directory, output, {"success": False, "issues": []},
                         expectation("robodojo-native.json", "stack_bowls", batch={"index": 0}), kind="robodojo")
        trace = json.loads(output.read_text())
        self.assertEqual(trace["goal"], "Stack the bowls.")
        self.assertEqual(trace["actionNames"][6], "left_gripper")
        # Only the vector the profile orders becomes curves; poses without channel names are left out.
        self.assertEqual(trace["proprioNames"], trace["actionNames"])
        self.assertEqual(trace["samples"][0]["proprio"], [round(value, 6) for value in joints])
        self.assertEqual([row["time"] for row in trace["samples"]], [0, 0.04])
        self.assertEqual(trace["cameras"][0]["name"], "cam_head")
        self.assertEqual(trace["cameras"][0]["video"]["path"], "episodes/trial.attempt/video.mp4")
        self.assertEqual(trace["cameras"][0]["video"]["timeMap"][1], {"time": 0.04, "videoTime": 0.06})
        self.assertEqual(trace["chunks"][1], {"label": "2", "start": 0.04, "end": 0.04, "inferSeconds": 0.123457})
        self.assertTrue(trace["samples"][-1]["truncated"])

    def test_robolab_uses_the_reference_control_rate_and_instruction(self):
        state = {"joint_position": [0.0] * 7, "gripper_position": [1.0]}
        output = episode(self.directory, [state] * 3, action=[0.0] * 8, horizon=750, initial=state, video=False)
        write_trajectory(self.directory, output, {"success": False, "issues": []},
                         expectation("robolab-native.json", "BananaInBowlTask"), kind="robolab")
        trace = json.loads(output.read_text())
        self.assertEqual(trace["goal"], "Pick up the banana and place it in the bowl")
        self.assertEqual(trace["proprioNames"][-2:], ["panda_joint7", "finger_joint/(pi/4)"])
        self.assertEqual([row["time"] for row in trace["samples"]], [0, round(1 / 15, 6), round(2 / 15, 6)])
        self.assertEqual(trace["cameras"], [])
        # The environment ended this failure before the control limit: terminated, not truncated.
        self.assertTrue(trace["samples"][-1]["terminated"])
        self.assertFalse(trace["samples"][-1]["truncated"])

    def test_kind_without_a_known_recording_writes_nothing(self):
        output = self.directory / "orbit-trajectory.json"
        write_trajectory(self.directory, output, {"success": True, "issues": []}, {}, kind="calvin")
        self.assertFalse(output.exists())

    def test_eb_navigation_indexes_the_policy_view_only_when_recorded(self):
        profile = semantic_profile()
        state = {"instruction": "Find the bread.", "navigation_pose": [1, 2, 90, 0]}
        output = episode(self.directory, [state, state], action=[2], horizon=20, initial=state)
        (self.directory / "overhead.mp4").write_bytes(b"synthetic")
        expected = {"sample": {"taskId": "base:01"}, "binding": {"benchmarkProfile": profile},
                    "reference": {"environment": {"controlHz": 5}}, "batch": {"index": 0}}
        result = {"success": True, "issues": []}

        write_trajectory(self.directory, output, result, expected, kind="eb-navigation")
        self.assertEqual([camera["name"] for camera in json.loads(output.read_text())["cameras"]],
                         ["front_rgb", "overhead_rgb"])

        (self.directory / POLICY_VIDEO).write_bytes(b"synthetic")
        write_trajectory(self.directory, output, result, expected, kind="eb-navigation")
        trace = json.loads(output.read_text())
        self.assertTrue(trace["frameBeforeAction"])
        self.assertEqual([camera["name"] for camera in trace["cameras"]],
                         ["front_rgb", "overhead_rgb", "navigation_views"])
        self.assertEqual(trace["cameras"][-1]["video"]["path"], "episodes/trial.attempt/" + POLICY_VIDEO)
        for camera in trace["cameras"]:
            self.assertEqual(camera["video"]["timeMap"],
                             [{"time": 0, "videoTime": 0.1}, {"time": 0.2, "videoTime": 0.3}])

    def test_longest_robolab_horizon_with_full_precision_vectors_fits_without_sampling(self):
        expected = expectation("robolab-native.json", "BananaInBowlTask")
        count = max(expected["reference"]["environment"]["horizons"].values())
        state = {"joint_position": [0.1234567891234567 * index for index in range(7)],
                 "gripper_position": [0.8123456789123456]}
        output = episode(self.directory, [state] * count, action=[0.9876543219876543] * 8,
                         horizon=count, initial=state)
        write_trajectory(self.directory, output, {"success": False, "issues": []}, expected, kind="robolab")
        trace = json.loads(output.read_text())
        self.assertLessEqual(output.stat().st_size, episode_trajectory.PREVIEW_LIMIT)
        self.assertEqual(episode_trajectory.encoded_size(trace), output.stat().st_size)
        self.assertEqual(len(trace["samples"]), count)
        self.assertEqual(len(trace["chunks"]), count)
        self.assertEqual(trace["completeness"], "environment-only")

    def test_sampled_preview_retains_original_video_times_final_outcome_and_all_chunks(self):
        state = {"joint_position": [0.123456789] * 7, "gripper_position": [0.25]}
        output = episode(self.directory, [state] * 200, action=[0.987654321] * 8, horizon=200,
                         initial=state, replan=10)
        write_json(self.directory / "chunks/7.json", {"inferSeconds": 7.0})
        expected = expectation("robolab-native.json", "BananaInBowlTask")
        # Multibyte goal text and the trailing newline count against the byte ceiling too.
        expected["reference"]["environment"]["instructions"]["BananaInBowlTask"] = "香蕉" * 10
        with patch.object(episode_trajectory, "PREVIEW_LIMIT", 8_000):
            write_trajectory(self.directory, output, {"success": True, "issues": []}, expected, kind="robolab")
        trace = json.loads(output.read_text())
        self.assertLessEqual(output.stat().st_size, 8_000)
        self.assertEqual(trace["completeness"], "truncated")
        self.assertLess(len(trace["samples"]), 200)
        self.assertEqual(len(trace["chunks"]), 20)
        self.assertEqual(trace["samples"][0]["time"], 0)
        self.assertEqual(trace["samples"][-1]["time"], round(199 / 15, 6))
        self.assertTrue(trace["samples"][-1]["terminated"])
        self.assertFalse(trace["samples"][-1]["truncated"])
        times = [sample["time"] for sample in trace["samples"]]
        self.assertIn(round(70 / 15, 6), times)
        self.assertIn(round(79 / 15, 6), times)
        self.assertEqual(times, sorted(set(times)))
        mapping = trace["cameras"][0]["video"]["timeMap"]
        self.assertEqual([frame["time"] for frame in mapping], times)
        for frame in mapping:
            step = round(frame["time"] * 15)
            self.assertEqual(frame["videoTime"], round((step + 0.5) / 15, 6))

    def test_sampling_excessive_chunks_keeps_the_first_last_and_slowest(self):
        state = {"joint_position": [0.0] * 7, "gripper_position": [1.0]}
        output = episode(self.directory, [state] * 200, action=[0.0] * 8, horizon=200, initial=state)
        write_json(self.directory / "chunks/79.json", {"inferSeconds": 10.0})
        with patch.object(episode_trajectory, "PREVIEW_LIMIT", 8_000):
            write_trajectory(self.directory, output, {"success": False, "issues": []},
                             expectation("robolab-native.json", "BananaInBowlTask"), kind="robolab")
        trace = json.loads(output.read_text())
        self.assertLessEqual(output.stat().st_size, 8_000)
        self.assertEqual(trace["completeness"], "truncated")
        self.assertLess(len(trace["chunks"]), 200)
        self.assertEqual(trace["chunks"][0]["label"], "1")
        self.assertEqual(trace["chunks"][-1]["label"], "200")
        self.assertIn({"label": "80", "start": round(79 / 15, 6), "end": round(79 / 15, 6),
                       "inferSeconds": 10.0}, trace["chunks"])

    def test_optional_video_failure_does_not_hide_the_numeric_timeline(self):
        state = {"joint_position": [0.0] * 7, "gripper_position": [1.0]}
        output = episode(self.directory, [state] * 2, action=[0.0] * 8, horizon=2, initial=state)
        write_trajectory(self.directory, output, {"success": False, "issues": ["optional video: broken"]},
                         expectation("robolab-native.json", "BananaInBowlTask"), kind="robolab")
        trace = json.loads(output.read_text())
        self.assertEqual(trace["cameras"], [])
        self.assertEqual(len(trace["samples"]), 2)

    def test_invalid_video_frame_rate_is_rejected(self):
        state = {"joint_position": [0.0] * 7, "gripper_position": [1.0]}
        output = episode(self.directory, [state], action=[0.0] * 8, horizon=1, initial=state)
        for fps in (0, -1, float("inf"), True):
            expected = expectation("robolab-native.json", "BananaInBowlTask")
            expected["reference"]["environment"]["controlHz"] = fps
            with self.subTest(fps=fps), self.assertRaisesRegex(ValueError, "frame rate"):
                write_trajectory(self.directory, output, {"success": True, "issues": []}, expected, kind="robolab")

    def test_index_over_the_preview_limit_is_refused(self):
        state = {"joint_position": [0.0] * 7, "gripper_position": [1.0]}
        output = episode(self.directory, [state] * 3, action=[0.0] * 8, horizon=3, initial=state)
        original = episode_trajectory.PREVIEW_LIMIT
        episode_trajectory.PREVIEW_LIMIT = 100
        self.addCleanup(setattr, episode_trajectory, "PREVIEW_LIMIT", original)
        with self.assertRaisesRegex(ValueError, "preview limit"):
            write_trajectory(self.directory, output, {"success": False, "issues": []},
                             expectation("robolab-native.json", "BananaInBowlTask"), kind="robolab")
        self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
