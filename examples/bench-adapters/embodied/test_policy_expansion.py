"""Check model-side I/O and frozen recipes with synthetic data."""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np


ADAPTER = Path(__file__).resolve().parent
sys.path.insert(0, str(ADAPTER.parents[1] / "sdk"))


def load(relative):
    path = ADAPTER / relative
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PolicyExpansionTests(unittest.TestCase):
    def test_droid_registration_requires_its_build_manifest_and_entrypoint(self):
        config = load("policies/openpi/configure_droid.py")
        from native_runtime import MANIFEST_LABEL

        manifest = config.policy_manifest("openpi-droid-policy", {"openpi": config.SOURCE},
                                          config.DOCKERFILE, config.POLICY / "serve_droid.py",
                                          interpreter="/.venv/bin/python")
        image_id = "sha256:" + "a" * 64
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            weights = root / "weights"
            (weights / "params").mkdir(parents=True)
            (weights / "params/manifest.ocdbt").write_bytes(b"fixture")
            (weights / "assets/droid").mkdir(parents=True)
            (weights / "assets/droid/norm_stats.json").write_text("{}")
            reference = root / "reference.json"
            reference.write_text(json.dumps({
                "benchmarkProfile": {"id": "molmospaces-franka-droid/1"},
                "parameters": {"replanSteps": 8},
            }))
            output = root / "policy.json"
            argv = ["configure_droid.py", "--policy-image", "test:policy", "--reference-file", str(reference),
                    "--weights", str(weights), "--output", str(output)]
            with patch.object(sys, "argv", argv):
                for build, entrypoint in (
                    ({**manifest, "kind": "starvla-policy"}, manifest["entrypoint"]),
                    (manifest, ["python", "/opt/orbit/serve_starvla.py"]),
                    (manifest, manifest["entrypoint"]),
                ):
                    inspection = json.dumps([{"Id": image_id, "Config": {
                        "Labels": {MANIFEST_LABEL: json.dumps(build)}, "Entrypoint": entrypoint,
                    }}])
                    with self.subTest(kind=build["kind"], entrypoint=entrypoint), patch(
                        "native_runtime.subprocess.check_output", return_value=inspection
                    ):
                        if build == manifest and entrypoint == manifest["entrypoint"]:
                            config.main()
                            self.assertEqual(json.loads(output.read_text())["service"]["image"], image_id)
                        else:
                            with self.assertRaisesRegex(ValueError, "matching build manifest and entrypoint"):
                                config.main()
                            self.assertFalse(output.exists())

    def test_droid_uses_native_camera_and_gripper_conventions(self):
        droid = load("policies/openpi/serve_droid.py")
        front = np.full((2, 2, 3), 2, dtype=np.uint8)
        wrist = np.full((2, 2, 3), 3, dtype=np.uint8)
        state = np.arange(7, dtype=np.float32)
        inputs = droid.droid_inputs({"front_rgb": front, "wrist_rgb": wrist, "state.arm": state,
                                    "state.gripper": np.array([1.0]), "instruction": "Pick the Cup"})
        self.assertIs(inputs["observation/exterior_image_1_left"], front)
        self.assertIs(inputs["observation/wrist_image_left"], wrist)
        self.assertIs(inputs["observation/joint_position"], state)
        self.assertEqual(inputs["observation/gripper_position"].tolist(), [1.0])
        self.assertEqual(inputs["prompt"], "pick the cup")
        actions = np.tile(np.arange(8, dtype=np.float32), (15, 1))
        actions[0, 7] = 0.5
        chunk = droid.droid_actions(actions)
        self.assertEqual(chunk.shape, (8, 8))
        np.testing.assert_array_equal(chunk[:, :7], actions[:8, :7])
        self.assertEqual(chunk[:, 7].tolist(), [0] + [255] * 7)
        self.assertEqual(actions[1, 7], 7)
        actions[0, 0] = np.nan
        with self.assertRaisesRegex(ValueError, "finite"):
            droid.droid_actions(actions)

    def test_lingbot_preserves_joint_order_and_camera_identity(self):
        lingbot = load("policies/lingbot-vla/serve_lingbot.py")
        state = np.arange(14, dtype=np.float64)
        inputs = lingbot.model_inputs({"head_camera": "head", "left_camera": "left", "right_camera": "right",
                                       "joint_state": state, "instruction": "Open the microwave"})
        self.assertEqual(inputs["observation.images.cam_high"], "head")
        self.assertEqual(inputs["observation.images.cam_left_wrist"], "left")
        self.assertEqual(inputs["observation.images.cam_right_wrist"], "right")
        self.assertEqual(inputs["task"], "Open the microwave")
        np.testing.assert_array_equal(inputs["observation.state"], state)
        self.assertEqual(inputs["observation.state"].dtype, np.float32)


if __name__ == "__main__":
    unittest.main()
