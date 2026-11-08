"""Synthetic transport and boundary checks; no checkpoint fidelity is inferred."""

import importlib.util
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

import numpy as np
from websockets.sync.server import serve

from orbit_embodied.driver import EpisodeFailure
from orbit_embodied.openvla import OpenVLAClient, libero_inputs, native_actions
from orbit_embodied.policy_ws import PolicyClient
from orbit_embodied.wire import pack, unpack


def observation():
    image = np.arange(256 * 256 * 3, dtype=np.uint8).reshape(256, 256, 3)
    return {"front_rgb": image, "wrist_rgb": image.copy(), "eef_position": np.array([1., 2., 3.]),
            "eef_quaternion": np.array([0., 0., 0., 1.]), "gripper_position": np.array([0.1, -0.1]),
            "instruction": "put the bowl on the plate"}


class OpenVLATests(unittest.TestCase):
    def test_policy_ws_requires_the_frozen_native_action_dimensions(self):
        client = PolicyClient.__new__(PolicyClient)
        client.action_size, client.replan_steps = 4, 5
        client.check_metadata({"actionSize": 4, "replanSteps": 5})
        for metadata in ({"actionSize": 7, "replanSteps": 5}, {"actionSize": 4, "replanSteps": 8}, []):
            with self.assertRaisesRegex(ValueError, "frozen profile"):
                client.check_metadata(metadata)

    def test_same_checkpoint_with_the_wrong_normalization_key_is_rejected_before_inference(self):
        path = Path(__file__).resolve().parents[2] / "bench-adapters/embodied/run.py"
        spec = importlib.util.spec_from_file_location("embodied_run", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        identity = {"checkpointDigest": "checkpoint", "normalizationDigest": "statistics",
                    "randomness": {"backend": "torch", "initialSeed": 0, "scope": "service"}}
        definition = {"connector": "openvla-ws", "port": 8000, "callTimeoutSec": 1, "replanSteps": 8,
                      "kind": "model", **identity, "normalizationKey": "libero_object_no_noops"}
        for key, valid in (("libero_spatial_no_noops", False), ("libero_object_no_noops", True)):
            client = Mock(metadata={"calibration": False, "orbit": identity, "unnormKey": key})
            policy = module.LazyPolicy(definition)
            with patch("orbit_embodied.openvla.OpenVLAClient", return_value=client):
                if valid:
                    policy.reset({"policySeed": 0})
                    client.reset.assert_called_once()
                else:
                    with self.assertRaisesRegex(ValueError, "normalization key"):
                        policy.reset({"policySeed": 0})
                    client.reset.assert_not_called()
                client.act.assert_not_called()
            policy.close()

    def test_native_input_rotation_and_state_preserve_the_raw_observation(self):
        raw = observation()
        result = libero_inputs(raw)
        np.testing.assert_array_equal(result["full_image"], raw["front_rgb"][::-1, ::-1])
        np.testing.assert_array_equal(result["wrist_image"], raw["wrist_rgb"][::-1, ::-1])
        np.testing.assert_array_equal(result["state"], [1., 2., 3., 0., 0., 0., 0.1, -0.1])
        self.assertEqual(raw["eef_quaternion"][3], 1)
        for changed in ({"front_rgb": np.zeros((224, 224, 3), dtype=np.uint8)},
                        {"eef_quaternion": np.array([0., 0., np.nan, 1.])}, {"instruction": ""}):
            with self.subTest(changed=list(changed)), self.assertRaises(ValueError):
                libero_inputs({**raw, **changed})

    def test_raw_nonfinite_values_are_rejected_before_gripper_binarization(self):
        for value in (np.inf, -np.inf, np.nan):
            raw = np.zeros((8, 7))
            raw[0, -1] = value
            with self.subTest(value=value), self.assertRaises(EpisodeFailure) as raised:
                native_actions(raw)
            self.assertEqual(raised.exception.kind, "policy_act")
            self.assertIs(raised.exception.rejected_actions, raw)
        for raw in (np.zeros((7, 7)), np.zeros((8, 8)), np.full((8, 7), "invalid")):
            with self.assertRaises(EpisodeFailure):
                native_actions(raw)

    def test_native_gripper_conversion_preserves_all_arm_coordinates(self):
        raw = np.arange(56, dtype=np.float32).reshape(8, 7) / 10
        raw[:, -1] = [0, .2, .49, .5, .51, .8, 1, 2]
        converted = native_actions(raw)
        np.testing.assert_array_equal(converted[:, :-1], raw[:, :-1])
        np.testing.assert_array_equal(converted[:, -1], [1, 1, 1, 0, -1, -1, -1, -1])
        self.assertTrue(np.signbit(converted[3, -1]))
        np.testing.assert_array_equal(raw[:, -1], np.array([0, .2, .49, .5, .51, .8, 1, 2], dtype=np.float32))
        unsigned = np.ones((8, 7), dtype=np.uint8)
        np.testing.assert_array_equal(native_actions(unsigned)[:, -1], -np.ones(8))

    def test_mismatched_service_recipe_is_rejected_at_handshake(self):
        for metadata in ({"ioAdapter": "libero-native", "actionChunkSize": 5},
                         {"ioAdapter": "gr00t-flat", "actionChunkSize": 8}, []):
            def handler(connection):
                connection.send(pack(metadata))
            with serve(handler, "127.0.0.1", 0) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    with self.assertRaisesRegex(ValueError, "recipe"):
                        OpenVLAClient("ws://127.0.0.1:" + str(server.socket.getsockname()[1]), timeout=2)
                finally:
                    server.shutdown()
                    thread.join(5)

    def test_transport_sends_raw_cameras_and_converts_the_returned_chunk(self):
        requests = []
        def handler(connection):
            connection.send(pack({"calibration": True, "ioAdapter": "libero-native", "actionChunkSize": 8}))
            requests.append(unpack(connection.recv()))
            connection.send(pack({"actions": np.zeros((8, 7), dtype=np.float32)}))
        with serve(handler, "127.0.0.1", 0) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            client = OpenVLAClient("ws://127.0.0.1:" + str(server.socket.getsockname()[1]), timeout=2)
            try:
                with self.assertRaisesRegex(ValueError, "reseeding"):
                    client.reset({"policySeed": 7})
                client.reset({"policySeed": 0})
                result = client.act(observation())
                # The client returns raw model output; the driver applies the named conversion.
                np.testing.assert_array_equal(result, np.zeros((8, 7)))
                self.assertEqual(client.conversion, "libero-gripper")
                np.testing.assert_array_equal(native_actions(result)[:, -1], np.ones(8))
                np.testing.assert_array_equal(requests[0]["front_rgb"], observation()["front_rgb"])
                self.assertEqual(requests[0]["instruction"], observation()["instruction"])
            finally:
                client.close()
                server.shutdown()
                thread.join(5)

    def test_model_errors_and_watchdogs_do_not_retry_stateful_calls(self):
        for error in ("synthetic inference failure", None):
            calls, stop = [], threading.Event()
            def handler(connection):
                connection.send(pack({"ioAdapter": "libero-native", "actionChunkSize": 8}))
                calls.append(connection.recv())
                if error:
                    connection.send(error)
                else:
                    stop.wait(2)
            with serve(handler, "127.0.0.1", 0) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                client = OpenVLAClient("ws://127.0.0.1:" + str(server.socket.getsockname()[1]), timeout=.2)
                try:
                    with self.assertRaises(RuntimeError if error else EpisodeFailure) as raised:
                        client.act(observation())
                    if not error:
                        self.assertEqual(raised.exception.kind, "call_watchdog")
                    self.assertEqual(len(calls), 1)
                finally:
                    stop.set()
                    client.close()
                    server.shutdown()
                    thread.join(5)

    def test_official_loader_can_only_modify_a_temporary_checkpoint_view(self):
        path = Path(__file__).resolve().parents[2] / "bench-adapters/embodied/serve_openvla.py"
        spec = importlib.util.spec_from_file_location("serve_openvla", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checkpoint, view = root / "source", root / "view"
            checkpoint.mkdir()
            view.mkdir()
            (checkpoint / "config.json").write_text('{"original": true}')
            (checkpoint / "model.safetensors").write_bytes(b"synthetic weights")
            module.prepare_checkpoint(checkpoint, view)
            (view / "config.json").write_text('{"changed": true}')
            self.assertEqual((checkpoint / "config.json").read_text(), '{"original": true}')
            self.assertTrue((view / "model.safetensors").is_symlink())


if __name__ == "__main__":
    unittest.main()
