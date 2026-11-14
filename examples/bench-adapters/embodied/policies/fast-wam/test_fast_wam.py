"""Fast-WAM's optional-IDM LIBERO protocol with a synthetic predictor."""

import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock, patch

import numpy as np
from PIL import Image


HERE = Path(__file__).resolve().parent


class FastWAMTests(unittest.TestCase):
    def test_both_modes_use_the_release_io_and_inference_settings(self):
        spec = importlib.util.spec_from_file_location(
            "serve_fast_wam", HERE / "serve_fast_wam.py",
        )
        service = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(service)

        # Independent expected values for the pinned runner's square-camera recipe.
        rng = np.random.default_rng(42)
        front, wrist = rng.integers(256, size=(2, 256, 256, 3), dtype=np.uint8)
        half = np.sqrt(0.5)
        observation = {
            "front_rgb": front, "wrist_rgb": wrist,
            "eef_position": [0.1, -0.2, 0.3], "eef_quaternion": [0, half, 0, half],
            "gripper_position": [0.04, -0.05], "instruction": "open the drawer",
        }
        expected_rgb = np.empty((224, 448, 3), dtype=np.uint8)
        for columns, raw in ((slice(0, 224), front), (slice(224, 448), wrist)):
            expected_rgb[:, columns] = Image.fromarray(raw).transpose(Image.Transpose.ROTATE_180).resize(
                (224, 224), Image.Resampling.BILINEAR,
            )
        expected_state = np.array([0.1, -0.2, 0.3, 0, np.pi / 2, 0, 0.04, -0.05], dtype=np.float32)
        denormalized = np.arange(32 * 7, dtype=np.float32).reshape(32, 7)
        denormalized[:, -1] = np.resize([0.2, 0.5, 0.8], 32)
        expected_actions = denormalized.copy()
        expected_actions[:, -1] = np.resize([1, 0, -1], 32)

        for mode in ("first_frame", "idm"):
            with self.subTest(mode=mode):
                self.check_inference(service, mode, observation, expected_rgb, expected_state,
                                     denormalized, expected_actions)

    def check_inference(self, service, mode, observation, expected_rgb, expected_state,
                        denormalized, expected_actions):
        tensor = Mock()
        tensor.permute.return_value.unsqueeze.return_value.to.side_effect = (
            lambda **_: torch.tensor.call_args.args[0].transpose(2, 0, 1)[None].astype(np.float32)
        )
        normalized_state = object()
        torch = SimpleNamespace(
            tensor=Mock(return_value=tensor), from_numpy=np.asarray,
            inference_mode=lambda: lambda infer: infer, manual_seed=Mock(), float32=object(), bfloat16=object(),
        )
        model = Mock(torch_dtype=torch.bfloat16)
        model.eval.return_value = model
        prediction = Mock()
        model.infer_action.return_value = {"action": prediction}
        processor = Mock()
        processor.eval.return_value = processor
        processor.normalizer.forward.return_value = {"state": {"default": normalized_state}}
        action_normalizer = Mock()
        processor.normalizer.normalizers = {"action": {"default": action_normalizer}}
        action_normalizer.backward.return_value.numpy.return_value = denormalized
        modules = {
            "torch": torch,
            "hydra": SimpleNamespace(compose=Mock(), initialize_config_dir=MagicMock()),
            "hydra.utils": SimpleNamespace(instantiate=Mock(side_effect=[model, processor])),
            "fastwam.datasets.lerobot.utils.normalizer": SimpleNamespace(load_dataset_stats_from_json=Mock()),
        }
        with patch.dict(sys.modules, modules), patch.dict(service.os.environ):
            actions = service.make_policy(Path("synthetic-weights"), mode)(observation)

        tensor.permute.assert_called_once_with(2, 0, 1)
        tensor.permute.return_value.unsqueeze.assert_called_once_with(0)
        processor.action_state_transform.assert_called_once()
        state = processor.action_state_transform.call_args.args[0]["state"]["default"]
        self.assertEqual(state.dtype, np.float32)
        np.testing.assert_allclose(state, expected_state[None], atol=1e-7)
        processor.normalizer.forward.assert_called_once_with(processor.action_state_transform.return_value)
        model.infer_action.assert_called_once()
        settings = model.infer_action.call_args.kwargs.copy()
        np.testing.assert_array_equal(settings.pop("input_image"),
                                      expected_rgb.transpose(2, 0, 1)[None].astype(np.float32) * (2.0 / 255.0) - 1.0)
        self.assertEqual(settings, dict(
            prompt="A video recorded from a robot's point of view executing the following instruction: open the drawer",
            proprio=normalized_state, action_horizon=32, num_video_frames=9, negative_prompt="", text_cfg_scale=1.0,
            num_inference_steps=10, sigma_shift=1.0, seed=42, rand_device="cpu", tiled=False,
            compile_action_infer=False, action_infer_mode=mode,
        ))
        prediction.to.assert_called_once_with(dtype=torch.float32, device="cpu")
        action_normalizer.backward.assert_called_once_with(prediction.to.return_value)
        np.testing.assert_array_equal(actions, expected_actions)
