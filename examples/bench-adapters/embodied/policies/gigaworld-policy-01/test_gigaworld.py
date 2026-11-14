"""Contract checks for GigaWorld's published RoboCasa365 channel ordering."""

import importlib.util
from pathlib import Path
import unittest

import numpy as np


class GigaWorldTests(unittest.TestCase):
    def test_model_receives_reference_layout_and_returns_native_orders(self):
        spec = importlib.util.spec_from_file_location("serve_gigaworld", Path(__file__).with_name("serve_gigaworld.py"))
        service = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(service)

        left, wrist, right = [np.full((256, 256, 3), value, np.uint8) for value in (24, 42, 70)]
        robot_state = np.arange(16, dtype=np.float64)
        base_pos, base_rot, ee_pos, ee_rot, gripper = np.split(robot_state, [3, 7, 10, 14])
        raw = {"video.robot0_agentview_left": left, "video.robot0_eye_in_hand": wrist,
               "video.robot0_agentview_right": right, "annotation.human.task_description": "open the cabinet",
               "state.base_position": base_pos, "state.base_rotation": base_rot,
               "state.end_effector_position_relative": ee_pos, "state.end_effector_rotation_relative": ee_rot,
               "state.gripper_qpos": gripper}
        observation = service.model_input(raw)
        self.assertIs(observation["observation/image"], left)
        self.assertIs(observation["observation/wrist_image"], wrist)
        self.assertIs(observation["observation/right_image"], right)
        self.assertEqual(observation["prompt"], "open the cabinet")
        np.testing.assert_array_equal(observation["observation/state"], robot_state)

        upstream = np.arange(24 * 12, dtype=np.float32).reshape(24, 12)
        native = service.native_chunk(upstream)
        np.testing.assert_array_equal(native, upstream[:, [5, 6, 7, 8, 9, 10, 11, 0, 1, 2, 3, 4]])
        upstream[3, 1] = np.nan
        with self.assertRaisesRegex(ValueError, "invalid RoboCasa365"):
            service.native_chunk(upstream)
