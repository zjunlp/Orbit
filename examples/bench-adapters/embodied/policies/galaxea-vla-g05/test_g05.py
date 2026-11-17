"""Check the G0.5 wrapper with synthetic model outputs and the released CPU processors."""

from contextlib import ExitStack
import importlib.util
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch, sentinel

import numpy as np

from orbit_embodied import EpisodeFailure


spec = importlib.util.spec_from_file_location("serve_g05", Path(__file__).with_name("serve_g05.py"))
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


def action_tensor(values):
    tensor = Mock(shape=values.shape)
    tensor.detach.return_value.cpu.return_value.float.return_value.numpy.return_value = values
    return tensor


class G05InferenceTests(unittest.TestCase):
    def setUp(self):
        self.weights = Path("synthetic-weights")
        self.config = SimpleNamespace(
            embodiment="robotwin", action_head="flow", runtime_system="system1", n_obs_steps=1,
            raw_state_dim=14, raw_action_dim=14, policy_action_dim=20, chunk_size=32, n_action_steps=8,
        )
        self.pre = Mock(return_value=sentinel.prepared)
        self.post = Mock()
        self.model = Mock()
        self.model.predict_action_chunk.return_value = action_tensor(np.zeros((1, 32, 20), dtype=np.float32))
        self.load_config = Mock(return_value=self.config)
        self.load_model = Mock(return_value=self.model)
        self.load_processors = Mock(return_value=(self.pre, self.post))
        self.seed = Mock()
        modules = {
            "torch": SimpleNamespace(inference_mode=lambda: lambda fn: fn, manual_seed=self.seed),
            "lerobot.policies.g05.configuration_g05": SimpleNamespace(
                G05Config=SimpleNamespace(from_pretrained=self.load_config),
            ),
            "lerobot.policies.g05.modeling_g05": SimpleNamespace(
                G05Policy=SimpleNamespace(from_pretrained=self.load_model),
            ),
            "lerobot.policies.g05.processor_g05": SimpleNamespace(
                make_g05_pre_post_processors_from_pretrained=self.load_processors,
            ),
        }
        mocks = ExitStack()
        self.addCleanup(mocks.close)
        mocks.enter_context(patch.dict(sys.modules, modules))
        self.inputs = mocks.enter_context(patch.object(service, "model_inputs", return_value=sentinel.inputs))

    def test_full_horizon_is_postprocessed_before_selecting_eight_controls(self):
        predict = self.model.predict_action_chunk
        normalized = np.arange(32 * 20, dtype=np.float32).reshape(1, 32, 20)
        prediction = action_tensor(normalized)
        predict.return_value = prediction
        native = normalized[..., :14] + np.arange(32, dtype=np.float32)[None, :, None]
        self.post.return_value = action_tensor(native)

        infer, _ = service.build(self.weights)
        actions = infer(sentinel.observation)

        self.load_config.assert_called_once_with(self.weights, local_files_only=True)
        self.load_processors.assert_called_once_with(
            self.config, str(self.weights), preprocessor_overrides={"device_processor": {"device": "cuda"}},
        )
        self.load_model.assert_called_once_with(
            self.weights, config=self.config, local_files_only=True, strict=True,
        )
        self.inputs.assert_called_once_with(sentinel.observation)
        self.pre.assert_called_once_with(sentinel.inputs)
        predict.assert_called_once_with(sentinel.prepared)
        self.post.assert_called_once_with(prediction)
        np.testing.assert_array_equal(actions, native[0, :8])

    def test_episode_reset_clears_model_and_processors_without_reseeding(self):
        infer, reset = service.build(self.weights)
        self.post.return_value = action_tensor(np.zeros((1, 32, 14), dtype=np.float32))

        for episode in (1, 2):
            reset()
            self.assertEqual(self.model.reset.call_count, episode)
            self.assertEqual(self.pre.reset.call_count, episode)
            self.assertEqual(self.post.reset.call_count, episode)
            infer(sentinel.observation)

        self.assertEqual(self.model.predict_action_chunk.call_count, 2)
        self.seed.assert_called_once_with(0)

    def test_incompatible_configs_stop_before_loading_model_or_processors(self):
        for field, value in (
            ("embodiment", "libero"), ("action_head", "actioncodec"), ("runtime_system", "system2"),
            ("n_obs_steps", 2), ("raw_state_dim", 20), ("raw_action_dim", 20),
            ("policy_action_dim", 27), ("chunk_size", 8), ("n_action_steps", 16),
        ):
            with self.subTest(field=field), patch.object(self.config, field, value):
                with self.assertRaisesRegex(ValueError, "expected the LeRobot G0.5 RoboTwin System 1"):
                    service.build(self.weights)
        self.load_model.assert_not_called()
        self.load_processors.assert_not_called()

    def test_malformed_predictions_never_reach_postprocessing(self):
        infer, _ = service.build(self.weights)
        for shape in ((1, 1, 20), (1, 32, 1), (32, 20), (2, 32, 20)):
            with self.subTest(shape=shape):
                raw = np.arange(np.prod(shape), dtype=np.float32).reshape(shape)
                self.model.predict_action_chunk.return_value = action_tensor(raw)
                with self.assertRaisesRegex(EpisodeFailure, "malformed raw action prediction") as caught:
                    infer(sentinel.observation)
                self.assertEqual(caught.exception.kind, "policy_act")
                np.testing.assert_array_equal(caught.exception.rejected_actions, raw)
        self.post.assert_not_called()

    def test_malformed_postprocessed_actions_are_rejected_with_evidence(self):
        infer, _ = service.build(self.weights)
        for shape in ((2, 32, 14), (1, 8, 14), (1, 32, 20)):
            with self.subTest(shape=shape):
                native = np.zeros(shape, dtype=np.float32)
                self.post.return_value = action_tensor(native)
                with self.assertRaisesRegex(EpisodeFailure, "malformed RoboTwin action chunk") as caught:
                    infer(sentinel.observation)
                self.assertEqual(caught.exception.kind, "policy_act")
                np.testing.assert_array_equal(caught.exception.rejected_actions, native)


@unittest.skipUnless(os.environ.get("ORBIT_G05_TEST_WEIGHTS"), "set ORBIT_G05_TEST_WEIGHTS to the release")
class G05ReleasedProcessorTests(unittest.TestCase):
    def setUp(self):
        from lerobot.policies.g05.configuration_g05 import G05Config
        from lerobot.policies.g05.processor_g05 import make_g05_pre_post_processors_from_pretrained

        self.weights = Path(os.environ["ORBIT_G05_TEST_WEIGHTS"])
        self.config = G05Config.from_pretrained(self.weights, local_files_only=True, cli_overrides=["--device=cpu"])
        self.pre, self.post = make_g05_pre_post_processors_from_pretrained(
            self.config, str(self.weights), preprocessor_overrides={"device_processor": {"device": "cpu"}},
        )

    def test_camera_frames_match_native_uint8_resize(self):
        import torch

        rng = np.random.default_rng(7)
        observation = {
            camera: rng.integers(0, 256, (240, 320, 3), dtype=np.uint8)
            for camera in service.CAMERAS
        }
        observation.update(joint_state=np.zeros(14), instruction="adjust the bottle")
        actual = {
            key: value.clone()
            for key, value in self.pre(service.model_inputs(observation))["pixel_values"].items()
        }
        self.pre.reset()
        expected = self.pre({
            "observation.state": torch.zeros(14),
            "task": observation["instruction"],
            **{
                "observation.images." + camera: torch.from_numpy(rgb.transpose(2, 0, 1).copy())
                for camera, rgb in observation.items() if camera in service.CAMERAS
            },
        })["pixel_values"]
        self.assertEqual(set(actual), set(expected))
        for camera in expected:
            torch.testing.assert_close(actual[camera], expected[camera], rtol=0, atol=0)

    def test_full_horizon_matches_queued_controls_after_partial_episode_reset(self):
        import torch

        post = self.post
        actions = torch.linspace(-0.4, 0.4, 32 * 20).reshape(1, 32, 20)
        full = post(actions.clone())
        self.assertEqual(tuple(full.shape), (1, 32, 14))
        self.assertTrue(torch.isfinite(full).all().item())
        for step in range(3):
            post(actions[:, step].clone())
        post.reset()
        queued = torch.stack([post(actions[:, step].clone()) for step in range(8)], dim=1)
        torch.testing.assert_close(full[:, :8], queued, rtol=0, atol=0)

    def test_single_step_prediction_is_rejected_before_released_processor_broadcasts_it(self):
        import torch
        from lerobot.policies.g05 import processor_g05
        from lerobot.policies.g05.configuration_g05 import G05Config
        from lerobot.policies.g05.modeling_g05 import G05Policy

        raw = torch.linspace(-0.4, 0.4, 20).reshape(1, 1, 20)
        self.assertEqual(tuple(self.post(raw.clone()).shape), (1, 32, 14))
        model = Mock()
        model.predict_action_chunk.return_value = raw
        post = Mock(wraps=self.post)
        with patch.object(G05Config, "from_pretrained", return_value=self.config), \
                patch.object(G05Policy, "from_pretrained", return_value=model), \
                patch.object(processor_g05, "make_g05_pre_post_processors_from_pretrained",
                             return_value=(Mock(return_value=sentinel.prepared), post)), \
                patch.object(service, "model_inputs", return_value=sentinel.inputs):
            infer, _ = service.build(self.weights)
            with self.assertRaisesRegex(EpisodeFailure, "malformed raw action prediction") as caught:
                infer(sentinel.observation)
        self.assertEqual(caught.exception.kind, "policy_act")
        np.testing.assert_array_equal(caught.exception.rejected_actions, raw.numpy())
        post.assert_not_called()
