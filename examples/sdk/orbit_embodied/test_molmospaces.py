"""Regression checks for frozen MolmoSpaces control and stopping evidence."""

import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from orbit_embodied.molmospaces import MolmoSpacesBenchmark, verify_molmospaces


class MolmoSpacesTests(unittest.TestCase):
    def test_articulated_reset_restores_native_grasp_lookup_after_failure(self):
        def lookup(_uid, _joint, grasp_libraries=None):
            return grasp_libraries

        grasps = SimpleNamespace(get_joint_grasp_path=lookup)

        def sample_task(*, house_index):
            self.assertEqual(house_index, 13)
            self.assertEqual(grasps.get_joint_grasp_path("Drawer", "joint"), ("droid",))
            raise RuntimeError("native sampler failure")

        benchmark = MolmoSpacesBenchmark.__new__(MolmoSpacesBenchmark)
        benchmark.task = "open-v1"
        benchmark.spec = SimpleNamespace(house_index=13)
        benchmark.sampler = SimpleNamespace(sample_task=sample_task)
        modules = {"molmo_spaces.utils": SimpleNamespace(grasps=grasps)}
        with patch.dict(sys.modules, modules), self.assertRaisesRegex(RuntimeError, "native sampler failure"):
            benchmark._sample_task()
        self.assertIs(grasps.get_joint_grasp_path, lookup)

    def test_driver_preserves_native_arm_and_gripper_commands(self):
        class SyntheticTask:
            def step(self, command):
                self.command = command
                return [{}], np.array([0.25]), np.array([False]), np.array([False]), [{}]

            @staticmethod
            def judge_success():
                return True

        benchmark = MolmoSpacesBenchmark.__new__(MolmoSpacesBenchmark)
        benchmark.reference = {"parameters": {"policyDtMs": 66, "endOnSuccess": True}}
        benchmark.steps = 0
        benchmark.env = SyntheticTask()
        benchmark.observation = lambda raw: raw[0]
        command = np.array([0.1, -0.2, 0.3, -0.4, 0.5, -0.6, 0.7, 255])
        result = benchmark.step(command)
        np.testing.assert_array_equal(benchmark.env.command["arm"], command[:7])
        np.testing.assert_array_equal(benchmark.env.command["gripper"], [255])
        self.assertEqual(result.native_action, command.tolist())
        self.assertFalse(result.native_done)
        self.assertTrue(result.success)
        self.assertTrue(result.terminated)
        command[7] = 0.5
        with self.assertRaisesRegex(ValueError, "0/255"):
            benchmark.step(command)

    def test_verifier_checks_command_and_stop_reason(self):
        action = [0.1] * 7 + [255]
        row = {"action": action, "nativeAction": action, "nativeDone": False,
               "nativeSuccess": True, "terminated": True}
        verify_molmospaces([row], 3, {"endOnSuccess": True})
        for changed in ({"nativeSuccess": False}, {"nativeAction": [0.1] * 7 + [0]}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                verify_molmospaces([{**row, **changed}], 3, {"endOnSuccess": True})
