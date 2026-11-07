"""Synthetic ZeroMQ endpoints; no checkpoint or simulator fidelity is inferred."""

import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest

import numpy as np
import zmq

from orbit_embodied import EpisodeFailure, StepResult, digest, resolve_binding, run_episode, verify_episode
from orbit_embodied.groot import GrootClient, libero_inputs, pack, unpack


REFERENCE = json.loads((Path(__file__).resolve().parents[2] / "bench-adapters/embodied/profiles/groot-widowx.json").read_text())


class Endpoint:
    def __init__(self, *, timeout=False, ordering=None, libero=False, indices=None, actions=None):
        self.context = zmq.Context()
        self.socket = self.context.socket(zmq.REP)
        self.socket.setsockopt(zmq.LINGER, 0)
        port = self.socket.bind_to_random_port("tcp://127.0.0.1")
        self.url = "tcp://127.0.0.1:" + str(port)
        self.stop = threading.Event()
        self.timeout, self.ordering = timeout, ordering
        self.indices = list(range(16)) if indices is None else indices
        self.actions = actions or {}
        self.profile = copy.deepcopy(REFERENCE["policyProfile"])
        if libero:
            self.profile["observations"].pop("video.image_0")
            self.profile["observations"]["video.image"] = {}
            self.profile["observations"]["video.wrist_image"] = {}
            self.profile["observations"].pop("state.pad")
        self.requests, self.inputs = [], None
        self.thread = threading.Thread(target=self.run)
        self.thread.start()

    def run(self):
        profile = self.profile
        while not self.stop.is_set():
            if not self.socket.poll(20):
                continue
            request = unpack(self.socket.recv())
            self.requests.append(request["endpoint"])
            if request["endpoint"] == "orbit_identity":
                result = {"calibration": True, "orbit": {"randomness": {"backend": "stateless", "scope": "stateless"}}}
            elif request["endpoint"] == "get_modality_config":
                result = {key: {"__ModalityConfig__": True, "as_json": {"delta_indices": [0],
                    "modality_keys": [name.split(".", 1)[1] for name in profile["observations"] if name.startswith(key + ".")]}}
                          for key in ("video", "state")}
                result["language"] = {"delta_indices": [0], "modality_keys": ["annotation.human.action.task_description"]}
                result["action"] = {"delta_indices": self.indices, "modality_keys": self.ordering or profile["action"]["order"]}
            elif request["endpoint"] == "reset":
                result = {}
            else:
                self.inputs = request["data"]["observation"]
                if self.timeout:
                    self.stop.wait(2)
                    break
                result = [{"action." + key: np.full((1, len(self.indices), 1), index, dtype=np.float32)
                           for index, key in enumerate(profile["action"]["order"])}, {}]
                result[0].update(self.actions)
            self.socket.send(pack(result))

    def close(self):
        self.stop.set()
        self.thread.join(timeout=3)
        self.socket.close()
        self.context.term()


class GrootTests(unittest.TestCase):
    def observation(self):
        return {name: "把勺子放到毛巾上" if description["dtype"] == "string" else
                np.zeros(description["shape"], dtype=description["dtype"])
                for name, description in REFERENCE["policyProfile"]["observations"].items()}

    def test_real_transport_preserves_temporal_axes_language_and_action_order(self):
        server = Endpoint()
        client = None
        try:
            client = GrootClient(server.url, REFERENCE["policyProfile"], timeout=1, replan_steps=4)
            client.reset({"policySeed": 0})
            chunk = client.act(self.observation())
            np.testing.assert_array_equal(chunk, np.tile(np.arange(7), (16, 1)))
            self.assertEqual(server.inputs["video.image_0"].shape, (1, 1, 256, 256, 3))
            self.assertEqual(server.inputs["state.x"].shape, (1, 1, 1))
            self.assertEqual(server.inputs["state.x"].dtype, np.float32)
            self.assertEqual(server.inputs["annotation.human.action.task_description"], ["把勺子放到毛巾上"])
            self.assertEqual(server.requests, ["orbit_identity", "get_modality_config", "reset", "get_action"])
        finally:
            if client is not None:
                client.close()
            server.close()

    def test_inference_timeout_is_bounded_and_never_retried(self):
        server = Endpoint(timeout=True)
        client = GrootClient(server.url, REFERENCE["policyProfile"], timeout=0.1, replan_steps=4)
        try:
            with self.assertRaises(EpisodeFailure) as caught:
                client.act(self.observation())
            self.assertEqual(caught.exception.kind, "call_watchdog")
            self.assertEqual(server.requests.count("get_action"), 1)
        finally:
            client.close()
            server.close()

    def test_wrong_action_order_is_rejected_before_inference(self):
        order = copy.deepcopy(REFERENCE["policyProfile"]["action"]["order"])
        order.reverse()
        server = Endpoint(ordering=order)
        try:
            with self.assertRaisesRegex(ValueError, "ordering"):
                GrootClient(server.url, REFERENCE["policyProfile"], timeout=1)
            self.assertNotIn("get_action", server.requests)
        finally:
            server.close()

    def test_noncontiguous_action_times_are_rejected_before_inference(self):
        for indices in (list(range(0, 32, 2)), list(range(1, 17)), list(reversed(range(16))), [0] * 16):
            with self.subTest(indices=indices):
                server = Endpoint(indices=indices)
                client = None
                try:
                    with self.assertRaisesRegex(ValueError, "contiguous"):
                        client = GrootClient(server.url, REFERENCE["policyProfile"], timeout=1, replan_steps=4)
                    self.assertNotIn("get_action", server.requests)
                finally:
                    if client is not None:
                        client.close()
                    server.close()

    def test_dense_shorter_prediction_window_is_accepted(self):
        server = Endpoint(indices=list(range(8)))
        client = None
        try:
            client = GrootClient(server.url, REFERENCE["policyProfile"], timeout=1, replan_steps=4)
            chunk = client.act(self.observation())
            np.testing.assert_array_equal(chunk, np.tile(np.arange(7), (8, 1)))
        finally:
            if client is not None:
                client.close()
            server.close()

    def test_invalid_raw_actions_are_archived_and_never_executed(self):
        libero = json.loads((Path(__file__).resolve().parents[2] / "bench-adapters/embodied/reference.json").read_text())

        class Benchmark:
            action_size = 7
            def __init__(self, reference):
                self.horizon = reference.get("environment", {}).get("horizon", 220)
                self.steps, self.closed = 0, False
                self.observation = {name: "synthetic task" if description["dtype"] == "string" else
                    np.zeros(description["shape"], dtype=description["dtype"])
                    for name, description in reference["benchmarkProfile"]["observations"].items()}
            def reset(self, sample):
                return self.observation
            def state(self, observation):
                return {}
            def step(self, action):
                self.steps += 1
                return StepResult(self.observation, 1., True, True)
            def result(self):
                return {"success": True}
            def close(self):
                self.closed = True

        for reference, io_adapter in ((libero, "libero-native"), (REFERENCE, "gr00t-flat")):
            for field in ("x", "gripper"):
                cases = [(value, index) for value in (np.inf, -np.inf, np.nan) for index in (0, 15)] + [("invalid", 0)]
                for number, position in cases:
                    with self.subTest(adapter=io_adapter, field=field, value=number, position=position):
                        values = np.zeros((1, 16, 1), dtype=np.float32) if not isinstance(number, str) else np.full((1, 16, 1), "0", dtype="<U7")
                        values[0, position, 0] = number
                        server = Endpoint(libero=io_adapter == "libero-native", actions={"action." + field: values})
                        client = None
                        try:
                            client = GrootClient(server.url, reference["policyProfile"], timeout=1,
                                replan_steps=reference["parameters"]["replanSteps"], io_adapter=io_adapter)
                            benchmark = Benchmark(reference)
                            task = "libero_spatial:synthetic" if io_adapter == "libero-native" else reference["environment"]["tasks"][0]
                            content = {"taskId": task, "benchmarkProfile": reference["id"], "initialStateId": "0",
                                "initialStateDigest": "sha256:" + "a" * 64, "environmentSeed": 7, "policySeed": 0, "repetition": 0}
                            sample = {**content, "sampleId": digest(content)}
                            binding = resolve_binding(reference["benchmarkProfile"], reference["policyProfile"], reference["observationMap"])
                            with tempfile.TemporaryDirectory() as temporary:
                                output = Path(temporary) / "episode"
                                result = run_episode(benchmark, client, sample, binding, output, "synthetic.attempt", {"reference": reference})
                                self.assertFalse(result["valid"])
                                self.assertEqual(result["failure"], "policy_act")
                                self.assertEqual(benchmark.steps, 0)
                                self.assertTrue(benchmark.closed)
                                rejection = json.loads((output / "chunks/0.rejected.json").read_text())
                                self.assertEqual(rejection["sourceObservation"], 0)
                                self.assertEqual(rejection["encoding"], "raw-policy-actions")
                                if not isinstance(number, str):
                                    raw = np.load(output / "chunks/0.rejected.npy", allow_pickle=False)
                                    index = client.order.index(field)
                                    np.testing.assert_array_equal(raw[:, index], values[0, :, 0])
                                    self.assertIn("chunks/0.rejected.npy", json.loads((output / "evidence-manifest.json").read_text())["files"])
                                else:
                                    self.assertIn("invalid", rejection["preview"])
                                    self.assertFalse((output / "chunks/0.rejected.npy").exists())
                                verified = verify_episode(output, sample["sampleId"], result["episodeId"])
                                self.assertFalse(verified["valid"])
                        finally:
                            if client is not None:
                                client.close()
                            server.close()

    def test_codec_refuses_pickle_bearing_arrays(self):
        with self.assertRaises(ValueError):
            pack(np.array([object()], dtype=object))
        import msgpack
        payload = {b"nd": True, b"kind": b"O", b"data": b"not pickle"}
        with self.assertRaisesRegex(ValueError, "object arrays"):
            unpack(msgpack.packb(payload))

    def test_libero_input_recipe_keeps_native_benchmark_coordinates_and_camera_rotation(self):
        camera = np.arange(12, dtype=np.uint8).reshape(2, 2, 3)
        value = {"front_rgb": camera, "wrist_rgb": camera.copy(), "eef_position": np.array([1., 2., 3.]),
                 "eef_quaternion": np.array([0., 0., 0., 1.]), "gripper_position": np.array([.01, .02]),
                 "instruction": "synthetic instruction"}
        prepared = libero_inputs(value)
        np.testing.assert_array_equal(prepared["video.image"], camera[::-1, ::-1])
        np.testing.assert_array_equal(prepared["video.wrist_image"], camera[::-1, ::-1])
        np.testing.assert_array_equal(prepared["state.roll"], np.zeros(1))
        self.assertEqual(prepared["state.x"].dtype, np.float32)
        np.testing.assert_array_equal(value["front_rgb"], camera)

    def test_libero_codec_reuses_raw_benchmark_and_converts_native_gripper(self):
        reference = json.loads((Path(__file__).resolve().parents[2] / "bench-adapters/embodied/reference.json").read_text())
        server = Endpoint(libero=True)
        client = None
        try:
            client = GrootClient(server.url, reference["policyProfile"], timeout=1, replan_steps=5, io_adapter="libero-native")
            camera = np.arange(12, dtype=np.uint8).reshape(2, 2, 3)
            chunk = client.act({"front_rgb": camera, "wrist_rgb": camera.copy(),
                "eef_position": np.zeros(3), "eef_quaternion": np.array([0., 0., 0., 1.]),
                "gripper_position": np.array([.01, .02]), "instruction": "test"})
            np.testing.assert_array_equal(chunk[:, :6], np.tile(np.arange(6), (16, 1)))
            np.testing.assert_array_equal(chunk[:, 6], -np.ones(16))
            np.testing.assert_array_equal(server.inputs["video.image"][0, 0], camera[::-1, ::-1])
            self.assertEqual(server.inputs["state.gripper"].shape, (1, 1, 2))
        finally:
            if client is not None:
                client.close()
            server.close()


if __name__ == "__main__":
    unittest.main()
