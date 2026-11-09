"""ManiSkill tabletop observation contracts with synthetic tensors."""

import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock

import numpy as np

from orbit_embodied.binding import resolve_binding, validate_observation
from orbit_embodied.tabletop import ManiSkillTabletopBenchmark

ADAPTER = Path(__file__).resolve().parents[2] / "bench-adapters/embodied"
sys.path.insert(0, str(ADAPTER))
from configure_maniskill import CATALOG, reference_for


def tensor(array):
    value = MagicMock()
    value[0].cpu().numpy.return_value = array
    return value


class ManiSkillObservationTests(unittest.TestCase):
    def test_hidden_targets_are_required_policy_inputs(self):
        profiles = json.loads(CATALOG.read_text())
        expected = {"PickCube-v1", "PickCubeSO100-v1", "PickCubeWidowXAI-v1",
                    "PickSingleYCB-v1", "TwoRobotPickCube-v1"}
        covered = set()
        for scope, profile in profiles.items():
            ref = reference_for(scope, profile, None)
            native = ref["benchmarkProfile"]
            fields = native["observations"]
            tasks = ref["environment"]["tasks"]
            if not expected.intersection(tasks):
                self.assertNotIn("goal_pos", fields)
                continue
            with self.subTest(scope=scope):
                self.assertEqual(len(tasks), 1)
                task = tasks[0]
                covered.add(task)
                benchmark = ManiSkillTabletopBenchmark(ref, task)
                rgb = np.zeros((128, 128, 3), dtype=np.uint8)
                raw = {"sensor_data": {f["camera"]: {"rgb": tensor(rgb)}
                                       for f in fields.values() if f["semantic"] == "rgb"},
                       "extra": {}}
                goal = np.array([0.1, -0.2, 0.3], dtype=np.float32)
                if task == "TwoRobotPickCube-v1":
                    site = SimpleNamespace(pose=SimpleNamespace(p=tensor(goal)))
                    benchmark.env = SimpleNamespace(unwrapped=SimpleNamespace(goal_site=site))
                else:
                    raw["extra"]["goal_pos"] = tensor(goal)
                binding = resolve_binding(native, native, ref["observationMap"])
                observation = benchmark.observation(raw)
                inputs = {name: observation[source] for name, source in binding["observationMap"].items()}
                validate_observation(inputs, fields)
                np.testing.assert_array_equal(inputs["goal_pos"], goal)
                self.assertEqual(benchmark.state(observation)["goal_pos"], goal.tolist())
                goal[0] = 0.9
                self.assertNotEqual(inputs["goal_pos"][0], benchmark.observation(raw)["goal_pos"][0])
                without_goal = {**native, "observations": {name: field for name, field in fields.items()
                                                          if name != "goal_pos"}}
                with self.assertRaisesRegex(ValueError, "cover exactly"):
                    resolve_binding(native, without_goal, ref["observationMap"])
        self.assertEqual(covered, expected)
