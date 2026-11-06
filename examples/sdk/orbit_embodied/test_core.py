"""Synthetic endpoint checks; these do not establish real policy or simulator fidelity."""

import copy
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

from orbit_embodied import StepResult, resolve_binding, run_episode, verify_episode
from orbit_embodied.evidence import seal
from orbit_embodied.openpi import quaternion_to_axis_angle


class SyntheticBenchmark:
    horizon = 7
    action_size = 7

    def __init__(self, success_at=None, fail_at=None):
        self.success_at, self.fail_at = success_at, fail_at
        self.count = 0
        self.closed = False

    def reset(self, sample):
        return {"state": np.zeros(3)}

    def state(self, observation):
        return {"state": observation["state"].tolist()}

    def step(self, action):
        if self.count == self.fail_at:
            raise RuntimeError("synthetic step failure")
        self.count += 1
        success = self.count == self.success_at
        return StepResult({"state": np.ones(3) * self.count}, float(success), success, success)

    def result(self):
        return {"success": self.count == self.success_at}

    def close(self):
        self.closed = True


class SyntheticPolicy:
    replan_steps = 5

    def __init__(self, invalid=False):
        self.calls = 0
        self.closed = False
        self.invalid = invalid

    def reset(self, sample):
        pass

    def act(self, observation):
        self.calls += 1
        return np.full((6, 7), np.nan if self.invalid else self.calls * 0.1)

    def close(self):
        self.closed = True


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.output = Path(self.temporary.name) / "episode"
        fields = {"state": {"semantic": "position", "dtype": "float64", "shape": [3], "frame": "world", "unit": "metre"}}
        self.benchmark_profile = {"id": "synthetic-benchmark", "observations": fields,
                                  "action": {"semantic": "synthetic-control", "controller": "synthetic", "shape": [7],
                                             "frame": "world", "unit": "normalized", "rotation": "axis-angle", "gripper": "native"}}
        self.policy_profile = {**self.benchmark_profile, "id": "synthetic-policy"}
        self.binding = resolve_binding(self.benchmark_profile, self.policy_profile, {"state": "state"})
        self.sample = {"sampleId": "synthetic-sample", "initialStateId": "0", "environmentSeed": 7}

    def tearDown(self):
        self.temporary.cleanup()

    def run_sample(self, benchmark, policy):
        return run_episode(benchmark, policy, self.sample, self.binding, self.output,
                           "synthetic-attempt", {"fixture": True})

    def verify(self):
        return verify_episode(self.output, "synthetic-sample", "synthetic-attempt")

    def test_requires_explicit_complete_semantically_equal_mapping(self):
        with self.assertRaisesRegex(ValueError, "exactly"):
            resolve_binding(self.benchmark_profile, self.policy_profile, {})
        changed = copy.deepcopy(self.policy_profile)
        changed["observations"]["state"]["frame"] = "tool"
        with self.assertRaisesRegex(ValueError, "semantics"):
            resolve_binding(self.benchmark_profile, changed, {"state": "state"})
        self.assertEqual(self.binding, resolve_binding(self.benchmark_profile, self.policy_profile, {"state": "state"}))

    def test_stops_mid_chunk_and_keeps_full_requested_chunk(self):
        benchmark, policy = SyntheticBenchmark(success_at=2), SyntheticPolicy()
        result = self.run_sample(benchmark, policy)
        self.assertTrue(result["success"])
        self.assertEqual(result["steps"], 2)
        self.assertEqual(policy.calls, 1)
        self.assertEqual(np.load(self.output / "chunks/0.npy").shape, (6, 7))
        self.assertTrue(self.verify()["valid"])
        self.assertTrue(benchmark.closed and policy.closed)

    def test_horizon_failure_is_valid_and_replans_after_consumed_prefix(self):
        policy = SyntheticPolicy()
        result = self.run_sample(SyntheticBenchmark(), policy)
        self.assertTrue(result["valid"])
        self.assertFalse(result["success"])
        self.assertEqual(policy.calls, 2)
        self.assertEqual(self.verify()["steps"], 7)

    def test_nonfinite_policy_and_environment_failure_remain_invalid(self):
        result = self.run_sample(SyntheticBenchmark(), SyntheticPolicy(invalid=True))
        self.assertEqual(result["failure"], "policy_act")
        self.assertFalse(self.verify()["valid"])
        self.assertTrue(np.isnan(np.load(self.output / "chunks/0.npy", allow_pickle=False)).all())

    def test_completed_actions_survive_later_environment_failure(self):
        result = self.run_sample(SyntheticBenchmark(fail_at=3), SyntheticPolicy())
        self.assertEqual(result["failure"], "env_step")
        self.assertEqual(self.verify()["steps"], 3)
        self.assertFalse(result["valid"])

    def test_rescore_rejects_other_samples_attempts_and_changed_files(self):
        self.run_sample(SyntheticBenchmark(), SyntheticPolicy())
        with self.assertRaisesRegex(ValueError, "another sample"):
            verify_episode(self.output, "other-sample", "synthetic-attempt")
        with self.assertRaisesRegex(ValueError, "another sample"):
            verify_episode(self.output, "synthetic-sample", "other-attempt")
        (self.output / "actions.jsonl").write_text("")
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            self.verify()

    def test_internal_action_consistency_even_after_resealing(self):
        result = self.run_sample(SyntheticBenchmark(), SyntheticPolicy())
        path = self.output / "actions.jsonl"
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        rows[0]["action"][0] = 999
        path.write_text("\n".join(json.dumps(row) for row in rows) + "\n")
        seal(self.output, result)
        with self.assertRaisesRegex(ValueError, "differs"):
            self.verify()

    def test_quaternion_zero_clipping_and_rotation_direction(self):
        np.testing.assert_array_equal(quaternion_to_axis_angle([0., 0., 0., 1.01]), np.zeros(3))
        np.testing.assert_allclose(quaternion_to_axis_angle([0., 0., 1., 0.]), [0., 0., np.pi])

    def test_optional_video_removal_does_not_invalidate_saved_scoring(self):
        result = self.run_sample(SyntheticBenchmark(), SyntheticPolicy())
        video = self.output / "video.mp4"
        video.write_bytes(b"synthetic optional media")
        seal(self.output, result)
        video.unlink()
        self.assertTrue(self.verify()["valid"])

    def test_optional_video_failure_does_not_replace_native_success(self):
        class BrokenVideo(SyntheticBenchmark):
            def start_video(self, directory):
                raise RuntimeError("synthetic encoder unavailable")
        result = self.run_sample(BrokenVideo(success_at=2), SyntheticPolicy())
        self.assertTrue(result["valid"] and result["success"])
        self.assertTrue(any("optional video" in issue for issue in result["issues"]))
        self.assertTrue(self.verify()["success"])


if __name__ == "__main__":
    unittest.main()
