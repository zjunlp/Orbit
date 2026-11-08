"""Actual binary WebSocket messages with a synthetic server, not a real VLA checkpoint."""

import threading
import unittest

import numpy as np
from openpi_client import msgpack_numpy
from websockets.sync.server import serve

from orbit_embodied.openpi import (
    OpenPIClient, prepare_libero_observation, prepare_robocasa_observation, prepare_robotwin_observation,
)


def observation():
    image = np.arange(256 * 256 * 3, dtype=np.uint8).reshape(256, 256, 3)
    return {"front_rgb": image, "wrist_rgb": image.copy(), "eef_position": np.array([1., 2., 3.]),
            "eef_quaternion": np.array([0., 0., 0., 1.]), "gripper_position": np.array([0.1, -0.1]),
            "instruction": "synthetic instruction"}


class OpenPITests(unittest.TestCase):
    def test_preprocessing_has_explicit_camera_rotation_state_and_instruction(self):
        raw = observation()
        result = prepare_libero_observation(raw)
        from openpi_client import image_tools
        expected = image_tools.resize_with_pad(np.ascontiguousarray(raw["front_rgb"][::-1, ::-1]), 224, 224)
        np.testing.assert_array_equal(result["observation/image"], expected)
        np.testing.assert_array_equal(result["observation/state"], [1., 2., 3., 0., 0., 0., 0.1, -0.1])
        self.assertEqual(result["prompt"], raw["instruction"])

    def test_robocasa_preserves_native_camera_orientation_and_state_order(self):
        from openpi_client import image_tools

        rows, columns = np.indices((256, 256), dtype=np.uint8)
        image = np.stack((rows, columns, rows ^ columns), axis=-1)
        cameras = {"agentview_left": image, "agentview_right": image[::-1], "eye_in_hand": image[:, ::-1]}
        raw = {"video.robot0_" + key: value for key, value in cameras.items()}
        state = np.arange(16, dtype=np.float32)
        raw.update({"state.end_effector_position_relative": state[0:3],
                    "state.end_effector_rotation_relative": state[3:7],
                    "state.base_position": state[7:10], "state.base_rotation": state[10:14],
                    "state.gripper_qpos": state[14:16], "annotation.human.task_description": "open the drawer"})
        result = prepare_robocasa_observation(raw)
        for key, camera in (("image", "agentview_left"), ("right_image", "agentview_right"),
                            ("wrist_image", "eye_in_hand")):
            expected = image_tools.resize_with_pad(np.ascontiguousarray(cameras[camera]), 224, 224)
            np.testing.assert_array_equal(result["observation/" + key], expected)
        np.testing.assert_array_equal(result["observation/state"], state)
        self.assertEqual(result["prompt"], "open the drawer")

    def test_robotwin_preserves_wrist_order_and_transposes_native_rgb(self):
        image = np.arange(4 * 5 * 3, dtype=np.uint8).reshape(4, 5, 3)
        raw = {"head_camera": image, "left_camera": image[::-1], "right_camera": image[:, ::-1],
               "joint_state": np.arange(14, dtype=np.float64), "instruction": "lift the bottle"}
        result = prepare_robotwin_observation(raw)
        for key, camera in (("cam_high", "head_camera"), ("cam_left_wrist", "left_camera"),
                            ("cam_right_wrist", "right_camera")):
            np.testing.assert_array_equal(result["images"][key], raw[camera].transpose(2, 0, 1))
        np.testing.assert_array_equal(result["state"], raw["joint_state"])
        self.assertEqual(result["prompt"], raw["instruction"])

    def test_native_binary_roundtrip_and_no_remote_reseed_claim(self):
        requests = []
        def handler(connection):
            connection.send(msgpack_numpy.packb({"fixture": True}))
            requests.append(msgpack_numpy.unpackb(connection.recv()))
            connection.send(msgpack_numpy.packb({"actions": np.zeros((10, 7), dtype=np.float32)}))
        with serve(handler, "127.0.0.1", 0) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            client = OpenPIClient("ws://127.0.0.1:" + str(server.socket.getsockname()[1]), timeout=2)
            try:
                self.assertTrue(client.metadata["fixture"])
                with self.assertRaisesRegex(ValueError, "reseeding"):
                    client.reset({"policySeed": 7})
                client.reset({"policySeed": 0})
                self.assertEqual(client.act(observation()).shape, (10, 7))
                self.assertEqual(requests[0]["observation/image"].dtype, np.uint8)
            finally:
                client.close()
                server.shutdown()
                thread.join(5)
            self.assertFalse(thread.is_alive())

    def test_text_error_is_not_retried_as_an_inference(self):
        calls = []
        def handler(connection):
            connection.send(msgpack_numpy.packb({"fixture": True}))
            calls.append(connection.recv())
            connection.send("synthetic inference failure")
        with serve(handler, "127.0.0.1", 0) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            client = OpenPIClient("ws://127.0.0.1:" + str(server.socket.getsockname()[1]), timeout=2)
            try:
                with self.assertRaisesRegex(RuntimeError, "synthetic inference failure"):
                    client.act(observation())
                self.assertEqual(len(calls), 1)
            finally:
                client.close()
                server.shutdown()
                thread.join(5)


if __name__ == "__main__":
    unittest.main()
