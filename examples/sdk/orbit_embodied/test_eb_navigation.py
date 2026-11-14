import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

from orbit_embodied import digest, resolve_binding, run_episode, verify_episode
from orbit_embodied.binding import seed_asset
from orbit_embodied.driver import StepResult
from orbit_embodied.eb_navigation import HORIZON, action_id, semantic_profile, verify_navigation


class NavigationEvidenceTest(unittest.TestCase):
    def test_native_success_stops_early_and_verifier_rejects_changed_pose(self):
        task = "base:01"
        row = {"instruction": "Find the bread.", "target_position": {"x": 2.0, "z": 0.0},
               "agentPose": {"position": {"x": 0.0, "z": 0.0}, "rotation": 90.0, "horizon": 0.0}}
        reference = {
            "environment": {"kind": "eb-navigation", "environmentSeed": 0, "horizon": HORIZON,
                            "initialStateCounts": {task: 1}, "initialStateDigests": {task: digest(row)},
                            "catalog": {task: row}},
            "parameters": {"settleSteps": 0, "replanSteps": 1},
        }
        sample = {"taskId": task, "initialStateId": "0", "initialStateDigest": seed_asset(reference, task),
                  "environmentSeed": 0, "policySeed": 0}
        sample["sampleId"] = digest(sample)
        profile = semantic_profile()
        policy_profile = {**profile, "observations": {"instruction": profile["observations"]["instruction"]}}
        binding = resolve_binding(profile, policy_profile, {"instruction": "instruction"})

        class Benchmark:
            horizon = HORIZON
            action_size = 1

            def reset(self, _):
                self.x = 0.0
                return self.state(None)

            def step(self, action):
                index = action_id(action)
                self.x += 0.25
                done = self.x >= 1
                return StepResult(self.state(None), float(done), done, done, native_action=[index], native_done=done)

            def result(self):
                return {"success": self.x >= 1, "distanceToTarget": 2 - self.x}

            def state(self, _):
                return {"instruction": row["instruction"], "navigation_pose": [self.x, 0.0, 90.0, 0.0]}

            def close(self):
                pass

        class Policy:
            replan_steps = 1

            def reset(self, _):
                pass

            def act(self, _):
                return np.array([[0]], dtype=np.int32)

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / "episode"
            result = run_episode(Benchmark(), Policy(), sample, binding, directory, "nav", {"reference": reference})
            self.assertEqual(verify_episode(directory, sample["sampleId"], "nav")["steps"], 4)
            self.assertTrue(result["success"])
            controls = [json.loads(line) for line in (directory / "actions.jsonl").read_text().splitlines()]
            initial = json.loads((directory / "initial-state.json").read_text())["state"]
            controls[-1]["state"]["navigation_pose"][0] = 0.99
            with self.assertRaisesRegex(ValueError, "stopping evidence"):
                verify_navigation(reference, sample, initial, controls, result)

    def test_action_ids_cannot_alias_a_valid_move_by_casting(self):
        for value in (-1, 8, 1.5, np.nan):
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, "action ID"):
                action_id([value])
