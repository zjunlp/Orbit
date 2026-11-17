"""RoboMME status, native actions, and frozen test-index evidence."""

import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import numpy as np

from orbit_embodied import digest, resolve_binding, run_episode, verify_episode
from orbit_embodied.binding import reset_seed, seed_asset
from orbit_embodied.evidence import seal, write_json
from orbit_embodied.robomme import RoboMMEBenchmark


sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "bench-adapters/embodied/benchmarks/robomme"))
from configure_robomme import reference


class RoboMMETests(unittest.TestCase):
    def test_native_status_controls_scoring_and_rejects_wrong_reset_evidence(self):
        frozen = {"seed": 730010, "difficulty": "medium"}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            test_data = root / "src/robomme/env_metadata/test"
            test_data.mkdir(parents=True)
            with patch("configure_robomme.test_catalog", return_value={"StopCube": [{"seed": 4}, frozen]}):
                recipe = reference(root)
            profile = recipe["benchmarkProfile"]
            binding = resolve_binding(profile, profile, recipe["observationMap"])
            sample = {"taskId": "StopCube", "initialStateId": "1", "environmentSeed": 0, "policySeed": 0,
                      "initialStateDigest": seed_asset(recipe, "StopCube"), "repetition": 0}
            sample["sampleId"] = digest(sample)
            self.assertEqual(reset_seed(sample, recipe), frozen["seed"])
            with self.assertRaisesRegex(ValueError, "outside the frozen"):
                reset_seed({**sample, "environmentSeed": 1}, recipe)

            frame = np.zeros((256, 256, 3), dtype=np.uint8)
            reset_obs = {"front_rgb_list": [frame, frame + 1], "wrist_rgb_list": [frame + 2, frame + 3],
                         "joint_state_list": [np.arange(7), np.arange(7) + 1],
                         "gripper_state_list": [np.array([0.01, 0.01]), np.array([0.04, 0.04])]}
            next_obs = {key: [values[-1]] for key, values in reset_obs.items()}
            for status in ("success", "fail", "timeout", "error"):
                with self.subTest(status=status):
                    env = Mock()
                    env.reset.return_value = reset_obs, {"task_goal": ["Wait", "Alternative"]}
                    result_obs = None if status == "error" else next_obs
                    info = {"status": status}
                    if status == "error":
                        info.update(exception_type="RuntimeError", error_message="synthetic simulator crash")
                    env.step.return_value = result_obs, 3, status != "timeout", status == "timeout", info
                    builder = Mock()
                    builder.get_episode_num.return_value = 50
                    builder.resolve_episode.return_value = frozen["seed"], frozen["difficulty"]
                    builder.make_env_for_episode.return_value = env
                    modules = {"robomme": SimpleNamespace(robomme_env=object()), "robomme.robomme_env": object(),
                               "robomme.env_record_wrapper": SimpleNamespace(BenchmarkEnvBuilder=Mock(return_value=builder))}
                    benchmark = RoboMMEBenchmark(recipe, "StopCube")
                    policy = Mock(replan_steps=16, conversion=None)
                    policy.act.return_value = np.full((20, 8), 0.25)
                    identity = {"reference": recipe}
                    episode = root / status
                    with patch.dict(sys.modules, modules), patch.object(benchmark, "start_video"), \
                            patch.object(benchmark, "record_frame"):
                        run_episode(benchmark, policy, sample, binding, episode, status, identity, reference=recipe)
                    builder.make_env_for_episode.assert_called_once_with(1)
                    env.close.assert_called_once()
                    np.testing.assert_array_equal(policy.act.call_args.args[0]["front_rgb"], frame + 1)
                    np.testing.assert_array_equal(policy.act.call_args.args[0]["wrist_rgb"], frame + 3)
                    self.assertEqual(policy.act.call_args.args[0]["instruction"], "Wait")
                    verified = verify_episode(episode, sample["sampleId"], status, reference=recipe)
                    self.assertEqual(verified["valid"], status != "error")
                    self.assertEqual(verified["success"], status == "success")
                    if status == "error":
                        self.assertEqual(verified["failure"], "env_step")
                        self.assertEqual(verified["steps"], 0)
                        self.assertEqual(verified["issues"],
                                         ["RoboMME simulator error (RuntimeError): synthetic simulator crash"])
                        continue
                    self.assertEqual(verified["steps"], 1)
                    self.assertEqual(verified["native"]["termination"], status)
                    self.assertEqual(verified["native"]["demonstrationFrames"], 1)
                    initial_file = episode / "initial-state.json"
                    changed = json.loads(initial_file.read_text())
                    changed["state"]["seed"] += 1
                    write_json(initial_file, changed)
                    seal(episode, verified)
                    with self.assertRaisesRegex(ValueError, "frozen test episode"):
                        verify_episode(episode, sample["sampleId"], status, reference=recipe)
