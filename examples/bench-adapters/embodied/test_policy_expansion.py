"""Check model-side I/O and frozen recipes with synthetic data."""

from fnmatch import fnmatch
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import ModuleType
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


def load_tests(loader, tests, pattern):
    for path in sorted((ADAPTER / "policies").glob("*/test_*.py")):
        if pattern is None or fnmatch(path.name, pattern):
            tests.addTests(loader.loadTestsFromModule(load(path.relative_to(ADAPTER)), pattern=pattern))
    return tests


class PolicyExpansionTests(unittest.TestCase):
    def test_dm05_registration_checks_its_fixed_quaternion_and_action_semantics(self):
        config = load("policies/dm05/configure_dm05.py")
        reference = json.loads((ADAPTER / "profiles/openvla-libero.json").read_text())
        reference["benchmarkProfile"]["id"] = "vla-arena-panda-raw/1"
        reference["environment"] = {"kind": "vla-arena", "protocol": "dm05"}
        reference["parameters"]["replanSteps"] = 10
        profile = config.policy_profile(reference)
        self.assertEqual(profile["id"], "dm05-vla-arena-input/1")

        reference["benchmarkProfile"]["observations"]["eef_quaternion"]["format"] = "wxyz"
        self.assertEqual(profile["observations"]["eef_quaternion"]["format"], "xyzw")
        with self.assertRaisesRegex(ValueError, "incompatible semantics for eef_quaternion"):
            config.policy_profile(reference)

        reference["benchmarkProfile"]["observations"]["eef_quaternion"]["format"] = "xyzw"
        reference["benchmarkProfile"]["action"]["rotation"] = "quaternion"
        with self.assertRaisesRegex(ValueError, "action semantics differ"):
            config.policy_profile(reference)

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

    def test_droid_randcam_has_a_separate_policy_binding_and_shares_weights(self):
        config = load("policies/openpi/configure_droid.py")
        molmo = load("benchmarks/molmospaces/configure_molmospaces.py")
        from orbit_embodied import resolve_binding

        standard = molmo.profile()
        randcam = molmo.profile()
        randcam["id"] = "molmospaces-franka-droid-exocentric/1"
        camera = "randomized_zed2_analogue_1"
        randcam["observations"]["front_rgb"]["camera"] = camera
        observation_map = {name: name for name in standard["observations"]}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "params").mkdir()
            (root / "params/manifest.ocdbt").write_bytes(b"fixture")
            (root / "assets/droid").mkdir(parents=True)
            (root / "assets/droid/norm_stats.json").write_text("{}")
            reference_path, output = root / "reference.json", root / "policy.json"
            reference = {"benchmarkProfile": randcam, "environment": {"frontCamera": camera},
                         "parameters": {"replanSteps": 8}}
            argv = ["configure_droid.py", "--policy-image", "test:policy", "--reference-file", str(reference_path),
                    "--weights", str(root), "--output", str(output), "--share-gpu"]
            with patch.object(sys, "argv", argv), patch.object(config, "require_image", return_value="sha256:" + "a" * 64):
                reference_path.write_text(json.dumps(reference))
                config.main()
                policy = json.loads(output.read_text())
                self.assertEqual(policy["name"], "pi05-droid-molmospaces-randcam")
                self.assertEqual(policy["weights"]["dataset"], "pi05-droid-molmospaces")
                self.assertEqual(policy["service"]["gpusOf"], "main")
                resolve_binding(randcam, policy["profile"], observation_map)
                with self.assertRaisesRegex(ValueError, "incompatible semantics for front_rgb"):
                    resolve_binding(standard, policy["profile"], observation_map)

                reference["environment"]["frontCamera"] = "another_camera"
                reference_path.write_text(json.dumps(reference))
                with self.assertRaisesRegex(ValueError, "published MolmoBot RandCam"):
                    config.main()

    def test_fast_vla_registration_checks_its_fixed_history_and_joint_semantics(self):
        config = load("policies/fast-vla/configure_fast_vla.py")
        reference = json.loads((ADAPTER / "profiles/robotwin-demo-clean.json").read_text())
        reference["environment"]["headCameraHistorySteps"] = [17, 8]
        benchmark = reference["benchmarkProfile"]
        benchmark["id"] = "robotwin-aloha-agilex-head-history/1"
        for steps in (17, 8):
            field = f"head_camera_t_minus_{steps}"
            benchmark["observations"][field] = {**benchmark["observations"]["head_camera"],
                                                "format": f"RGB-native-t-minus-{steps}"}
            reference["observationMap"][field] = field
        profile = config.policy_profile(reference)
        self.assertEqual(profile["id"], "fast-vla-robotwin-input/1")

        reference["observationMap"]["head_camera_t_minus_17"] = "head_camera_t_minus_8"
        with self.assertRaisesRegex(ValueError, "incompatible semantics for head_camera_t_minus_17"):
            config.policy_profile(reference)

        reference["observationMap"]["head_camera_t_minus_17"] = "head_camera_t_minus_17"
        benchmark["observations"]["joint_state"]["order"].reverse()
        self.assertNotEqual(benchmark["observations"]["joint_state"], profile["observations"]["joint_state"])
        with self.assertRaisesRegex(ValueError, "incompatible semantics for joint_state"):
            config.policy_profile(reference)

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

    def test_starvla_recipe_preserves_initial_scene_grid_and_native_action_order(self):
        from orbit_embodied import resolve_binding

        config = load("policies/starvla/configure_starvla.py")
        simpler = load("benchmarks/simpler-env/configure_simpler.py")
        reference = json.loads((ADAPTER / "profiles/groot-widowx.json").read_text())
        scene = {"objectEpisodes": [0, 24], "horizon": 60}
        environment = reference["environment"]
        environment.update(simplerRobot="widowx", tasks=sorted(config.TASKS),
                           horizons={task: 60 for task in config.TASKS},
                           simplerScenes={task: [dict(scene)] for task in config.TASKS})
        benchmark = {"config": {"reference": json.dumps(reference)}}
        with patch.object(config, "file_digest", return_value="sha256:" + "a" * 64):
            recipe = config.benchmark_recipe(benchmark, ADAPTER)
            digest = benchmark["config"]["profileDigest"]
            self.assertEqual(config.benchmark_recipe(benchmark, ADAPTER), recipe)
            self.assertEqual(benchmark["config"]["profileDigest"], digest)
            with patch.object(simpler, "file_digest", return_value="sha256:" + "b" * 64):
                simpler.use_policy_termination(reference, ADAPTER)
            terminated = {"config": {"reference": json.dumps(reference)}}
            converted = config.benchmark_recipe(terminated, ADAPTER)
            resolve_binding(converted["benchmarkProfile"], recipe["policyProfile"], converted["observationMap"])
            reference["benchmarkProfile"]["action"]["order"].append("terminate")
            invalid = {"config": {"reference": json.dumps(reference)}}
            with self.assertRaisesRegex(ValueError, "native WidowX action protocol"):
                config.benchmark_recipe(invalid, ADAPTER)
        self.assertTrue(recipe["environment"]["policyTermination"])
        self.assertEqual(recipe["parameters"]["successRule"], "last")
        self.assertEqual(recipe["parameters"]["replanSteps"], 1)
        self.assertEqual(recipe["benchmarkProfile"]["observations"]["video.image_0"]["shape"], [224, 224, 3])
        self.assertEqual(recipe["benchmarkProfile"]["action"]["order"],
                         ["x", "y", "z", "roll", "pitch", "yaw", "gripper", "terminate"])
        for scenes in recipe["environment"]["simplerScenes"].values():
            self.assertEqual(scenes, [{"objectEpisodes": [0, 24], "horizon": 120}])

        runner = load("run.py")
        request = {"reference": recipe, "sample": {"benchmarkProfile": recipe["id"], "taskId": min(config.TASKS)},
                   "policy": {"connector": "policy-ws", "replanSteps": 1}, "binding": {}, "episodeId": "example",
                   "trialId": "trial", "implementationDigest": "test"}
        with patch.dict("os.environ", {"ORBIT_RUN_ID": "run"}), patch.object(runner, "run_episode") as rollout:
            runner.execute_episode(request, None)
            rollout.assert_called_once()
            request["reference"]["parameters"]["renderSize"] = 256
            with self.assertRaisesRegex(ValueError, "driver settings differ"):
                runner.execute_episode(request, None)

        starvla = load("policies/starvla/serve_starvla.py")
        euler = ModuleType("transforms3d.euler")
        euler.euler2axangle = lambda roll, pitch, yaw: (np.array([1, 0, 0]), roll)
        with patch.dict(sys.modules, {"transforms3d.euler": euler}):
            action = starvla.native_action(np.array([1, 2, 3, 0.2, 0, 0, 0.6]))
        np.testing.assert_allclose(action, [[1, 2, 3, 0.2, 0, 0, 1, 0]])


if __name__ == "__main__":
    unittest.main()
