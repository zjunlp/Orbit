"""Episode index checks on synthetic control logs and the checked-in benchmark profiles; no simulator."""

import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from orbit_embodied import episode_trajectory
from orbit_embodied.calvin import CalvinBenchmark
from orbit_embodied.eb_navigation import POLICY_VIDEO, semantic_profile
from orbit_embodied.episode_trajectory import write_trajectory
from orbit_embodied.evidence import write_json
from orbit_embodied.vlabench import VLABenchBenchmark

PROFILES = Path(__file__).resolve().parents[2] / "bench-adapters/embodied/profiles"


def expectation(profile, task, **extra):
    reference = json.loads((PROFILES / profile).read_text())
    return {"sample": {"taskId": task}, "reference": reference,
            "binding": {"benchmarkProfile": reference["benchmarkProfile"]}, **extra}


def episode(directory, states, *, action, horizon, initial, video=True, replan=1, rewards=None,
            terminal=True):
    """Synthetic verified control logs; no native simulator or video encoder is involved."""
    rows = [{"phase": "control", "step": step, "chunk": step // replan, "action": action,
             "reward": rewards[step] if rewards is not None else 0.0,
             "terminated": terminal and step == len(states) - 1, "state": state}
            for step, state in enumerate(states)]
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
        self.assertNotIn("instructionChanges", trace)
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

    def test_libero_variants_use_the_recorded_instruction_from_the_first_frame(self):
        cases = (
            ("libero", "libero_spatial:pick_up_the_black_bowl_between_the_plate_and_the_ramekin",
             "Pick up the black bowl between the plate and the ramekin."),
            ("libero-pro", "libero_spatial:pick_up_the_black_bowl_between_the_plate_and_the_ramekin",
             "Pick up the black bowl not between the plate and the ramekin."),
            ("libero-mem", "libero_mem:KITCHEN_SCENE1_1_pick_up_the_bowl_and_place_it_back_on_the_plate",
             "pick up the bowl and place it back on the plate"),
        )
        for kind, task, instruction in cases:
            with self.subTest(kind=kind):
                directory = self.directory / kind
                directory.mkdir()
                state = {"instruction": instruction, "eef_position": [0.0] * 3,
                         "eef_quaternion": [0.0, 0.0, 0.0, 1.0], "gripper_position": [0.0] * 2}
                output = episode(directory, [state] * 2, action=[0.0] * 7, horizon=2, initial=state)
                expected = {"sample": {"taskId": task}, "reference": {"environment": {"kind": kind}}}

                write_trajectory(directory, output, {"success": True, "issues": []}, expected, kind="libero")

                trace = json.loads(output.read_text())
                self.assertEqual(trace["goal"], instruction)
                self.assertNotIn("instructionChanges", trace)

    def test_calvin_timeline_distinguishes_subtask_timeout_and_completion(self):
        expected = {"sample": {"taskId": "sequence"},
                    "reference": {"environment": {"kind": "calvin"}, "parameters": {"subtaskSteps": 2}},
                    "binding": {"benchmarkProfile": {"action": {"shape": [7]}, "observations": {}}}}
        cases = (("timeout", [1, 1, 0, 0], False), ("completed", [1] * 5, True))
        for name, rewards, success in cases:
            with self.subTest(name=name):
                directory = self.directory / name
                directory.mkdir()
                states = [{"completedSubtasks": sum(rewards[:step + 1])} for step in range(len(rewards))]
                output = episode(directory, states, action=[0.0] * 7, horizon=10,
                                 initial={"completedSubtasks": 0}, rewards=rewards)
                write_json(directory / "recording.json",
                           {"version": 1, "camera": "front_rgb", "path": "video.mp4", "fps": 30,
                            "frames": len(rewards)})

                write_trajectory(directory, output, {"success": success, "issues": []}, expected, kind="calvin")

                samples = json.loads(output.read_text())["samples"]
                flags = [(sample["terminated"], sample["truncated"]) for sample in samples]
                self.assertEqual(flags, [(False, False)] * (len(rewards) - 1) + [(success, not success)])

    def test_instruction_changes_start_on_the_next_recorded_frame(self):
        first, second = "Open the drawer.", "Lift the pink block."
        states = [{"instruction": text} for text in (first, second, "", "", "Done.")]
        output = episode(self.directory, states, action=[0.0] * 7, horizon=5, initial={"instruction": first})
        write_json(self.directory / "recording.json",
                   {"version": 1, "camera": "front_rgb", "path": "video.mp4", "fps": 30, "frames": 5})
        expected = {"sample": {"taskId": "sequence"},
                    "binding": {"benchmarkProfile": {"action": {"shape": [7]}, "observations": {}}}}

        write_trajectory(self.directory, output, {"success": True, "issues": []}, expected, kind="calvin")

        trace = json.loads(output.read_text())
        self.assertEqual(trace["goal"], first)
        self.assertEqual(trace["instructionChanges"], [{"time": 0, "text": first},
                                                        {"time": round(2 / 30, 6), "text": second},
                                                        {"time": 0.1, "text": ""}])
        mapping = trace["cameras"][0]["video"]["timeMap"]
        self.assertEqual(trace["instructionChanges"][1]["time"], mapping[2]["time"])
        self.assertEqual(trace["instructionChanges"][2]["time"], mapping[3]["time"])

    def test_colosseum_uses_recorded_language_and_its_fixed_step_limit(self):
        task, description = "RaiseCube-v1", "Lift the cube up to a certain height."
        expected = {"sample": {"taskId": task},
                    "reference": {"environment": {"kind": "colosseum-v2", "controlHz": 20,
                                                  "instructions": {task: description}}},
                    "binding": {"benchmarkProfile": {"action": {"shape": [7]}, "observations": {}}}}
        for name, state in (("language-none", {"instruction": ""}), ("unrecorded", {})):
            with self.subTest(name=name):
                directory = self.directory / name
                directory.mkdir()
                output = episode(directory, [state] * 2, action=[0.0] * 7, horizon=2, initial=state)

                write_trajectory(directory, output, {"success": True, "issues": []},
                                 expected, kind="colosseum-v2")

                trace = json.loads(output.read_text())
                self.assertEqual(trace["goal"], state.get("instruction", description))
                self.assertEqual(trace.get("instructionChanges"),
                                 [{"time": 0, "text": ""}] if "instruction" in state else None)
                self.assertFalse(trace["samples"][-1]["terminated"])
                self.assertTrue(trace["samples"][-1]["truncated"])

    def test_recorded_stop_reason_distinguishes_normal_ending_at_the_step_limit(self):
        expected = {"sample": {"taskId": "put_carrot_on_plate"},
                    "reference": {"environment": {"kind": "registered-gym", "controlHz": 5,
                                                  "policyTermination": True}},
                    "binding": {"benchmarkProfile": {"action": {"shape": [8]}, "observations": {}}}}
        cases = (("simulator-limit", True, True, True), ("policy-stop", True, False, False),
                 ("driver-limit", False, False, True))
        for name, terminal, native_truncation, expected_truncation in cases:
            with self.subTest(name=name):
                directory = self.directory / name
                directory.mkdir()
                initial = {"truncated": False}
                output = episode(directory, [initial, {"truncated": native_truncation}],
                                 action=[0.0] * 8, horizon=2, initial=initial, terminal=terminal)

                write_trajectory(directory, output, {"success": True, "issues": []},
                                 expected, kind="registered-gym")

                final = json.loads(output.read_text())["samples"][-1]
                self.assertEqual((final["terminated"], final["truncated"]),
                                 (not expected_truncation, expected_truncation))

    def test_calvin_and_vlabench_describe_their_front_camera_recordings(self):
        reference = {"environment": {"tasks": ["task"], "horizons": {"task": 2},
                                     "catalog": {"instructions": {}}},
                     "parameters": {"subtaskSteps": 2}}
        for recorder, fps in ((CalvinBenchmark, 30), (VLABenchBenchmark, 10)):
            with self.subTest(recorder=recorder):
                writer = Mock()
                get_writer = Mock(return_value=writer)
                benchmark = recorder(reference, "task")
                with patch.dict(sys.modules, {"imageio": SimpleNamespace(get_writer=get_writer)}):
                    recording = benchmark.start_video(self.directory)
                    benchmark.record_frame({"front_rgb": "front frame", "wrist_rgb": "wrist frame"})
                    benchmark.finish_video()
                self.assertEqual(recording, {"path": "video.mp4", "camera": "front_rgb", "fps": fps})
                get_writer.assert_called_once_with(str(self.directory / "video.mp4"), fps=fps)
                writer.append_data.assert_called_once_with("front frame")
                writer.close.assert_called_once_with()

    def test_vla_arena_indexes_unnamed_actions_at_the_recorded_frame_rate(self):
        state = {"instruction": "Move the bowl without touching the hazard.",
                 "eef_position": [0.1, 0.2, 0.3], "gripper_position": [0.0, 0.04]}
        action = [0.25] * 7
        output = episode(self.directory, [state, state], action=action, horizon=2, initial=state)
        expected = expectation("openvla-libero.json", "safety_hazard_avoidance/l0/test")
        recording = {"version": 1, "camera": "front_rgb", "path": "video.mp4", "fps": 20, "frames": 2}
        result = {"success": True, "issues": []}

        write_json(self.directory / "recording.json", recording)
        write_trajectory(self.directory, output, result, expected, kind="vla-arena")
        trace = json.loads(output.read_text())
        self.assertEqual(trace["goal"], state["instruction"])
        self.assertEqual(trace["actionNames"], [f"action {index}" for index in range(1, 8)])
        self.assertEqual(trace["proprioNames"], ["finger_joint1", "finger_joint2"])
        self.assertEqual(trace["samples"][1]["action"], action)
        self.assertEqual(trace["samples"][1]["proprio"], state["gripper_position"])
        self.assertEqual(trace["samples"][1]["time"], 0.05)
        self.assertTrue(trace["frameBeforeAction"])
        self.assertEqual(trace["cameras"][0]["name"], "front_rgb")
        self.assertEqual(trace["cameras"][0]["video"]["path"], "episode/video.mp4")
        self.assertEqual(trace["cameras"][0]["video"]["timeMap"],
                         [{"time": 0, "videoTime": 0.025}, {"time": 0.05, "videoTime": 0.075}])

    def test_incomplete_recording_keeps_its_numeric_timeline(self):
        state = {"instruction": "Open the drawer."}
        action = [0.0] * 7
        output = episode(self.directory, [state, state], action=action, horizon=2, initial=state)
        expected = expectation("openvla-libero.json", "safety_hazard_avoidance/l0/test")
        write_json(self.directory / "recording.json",
                   {"version": 1, "camera": "front_rgb", "path": "video.mp4", "fps": 20, "frames": 1})

        write_trajectory(self.directory, output, {"success": True, "issues": []},
                         expected, kind="vla-arena")
        trace = json.loads(output.read_text())
        self.assertEqual(trace["cameras"], [])
        self.assertEqual([sample["time"] for sample in trace["samples"]], [0, 0.05])
        self.assertEqual(trace["samples"][1]["action"], action)
        self.assertEqual(trace["samples"][1]["reward"], 0.0)

    def test_numeric_timeline_uses_the_frozen_task_control_rate_without_recording(self):
        task = "simpler_env_widowx/widowx_open_drawer"
        state = {"instruction": "Open the drawer."}
        output = episode(self.directory, [state, state], action=[0.0] * 7, horizon=2, initial=state)
        expected = expectation("groot-widowx.json", task)
        expected["reference"]["environment"]["controlRates"] = {task: 3}

        write_trajectory(self.directory, output, {"success": True, "issues": []},
                         expected, kind="registered-gym")
        trace = json.loads(output.read_text())
        self.assertEqual(trace["cameras"], [])
        self.assertEqual([sample["time"] for sample in trace["samples"]], [0, 0.333333])
        self.assertEqual(trace["actionNames"], ["x", "y", "z", "roll", "pitch", "yaw", "gripper"])

    def test_eb_navigation_indexes_the_policy_view_only_when_recorded(self):
        profile = semantic_profile()
        state = {"instruction": "Find the bread.", "navigation_pose": [1, 2, 90, 0]}
        output = episode(self.directory, [state, state], action=[2], horizon=20, initial=state)
        (self.directory / "overhead.mp4").write_bytes(b"synthetic")
        expected = {"sample": {"taskId": "base:01"}, "binding": {"benchmarkProfile": profile},
                    "reference": {"environment": {"controlHz": 5}}, "batch": {"index": 0}}
        result = {"success": True, "issues": []}

        write_trajectory(self.directory, output, result, expected, kind="eb-navigation")
        unrecorded = json.loads(output.read_text())
        self.assertEqual([chunk["fallback"] for chunk in unrecorded["chunks"]], ["unrecorded", "unrecorded"])
        self.assertEqual([camera["name"] for camera in unrecorded["cameras"]],
                         ["front_rgb", "overhead_rgb"])

        for index, fallback in enumerate(("empty-plan", "invalid-plan")):
            (self.directory / "chunks" / f"{index}.json").write_text(json.dumps(
                {"inferSeconds": 0.1, "fallback": fallback}))
        (self.directory / POLICY_VIDEO).write_bytes(b"synthetic")
        write_trajectory(self.directory, output, result, expected, kind="eb-navigation")
        trace = json.loads(output.read_text())
        self.assertEqual([chunk["fallback"] for chunk in trace["chunks"]], ["empty-plan", "invalid-plan"])
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
