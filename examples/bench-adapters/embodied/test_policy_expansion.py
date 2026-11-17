"""Check model-side I/O and frozen recipes with synthetic data."""

from argparse import Namespace
from fnmatch import fnmatch
import copy
import importlib.util
import json
from pathlib import Path
import runpy
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
    def assert_action_policy_registration(self, script, reference, observation, field, incompatible):
        config = ADAPTER / "policies" / script
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reference_path, output = root / "reference.json", root / "policy.json"
            argv = [str(config), "--source", str(root), "--policy-image", "test:policy",
                    "--reference-file", str(reference_path), "--weights", str(root), "--output", str(output)]
            identities = {"checkpointDigest": "sha256:" + "a" * 64, "normalizationDigest": "sha256:" + "b" * 64}
            with patch.object(sys, "argv", argv), patch.object(sys, "path", [str(config.parent), str(ADAPTER), *sys.path]), \
                    patch("native_runtime.check_policy_source"), \
                    patch("native_runtime.require_image", return_value="sha256:" + "c" * 64), \
                    patch("native_runtime.file_digest", return_value="sha256:" + "d" * 64), \
                    patch("orbit_embodied.assets.policy_asset_digests", return_value=identities):
                reference_path.write_text(json.dumps(reference))
                runpy.run_path(str(config), run_name="__main__")
                registered = json.loads(output.read_text())
                self.assertEqual(registered["profile"]["observations"], reference["benchmarkProfile"]["observations"])
                self.assertEqual(registered["profile"]["action"], reference["benchmarkProfile"]["action"])
                output.unlink()

                descriptor = reference["benchmarkProfile"]["observations"][observation]
                original = descriptor[field]
                descriptor[field] = incompatible
                reference_path.write_text(json.dumps(reference))
                with self.assertRaisesRegex(ValueError, "incompatible semantics for " + observation):
                    runpy.run_path(str(config), run_name="__main__")
                descriptor[field] = original
                action = reference["benchmarkProfile"]["action"]
                action["order"] = list(reversed(action["order"]))
                reference_path.write_text(json.dumps(reference))
                with self.assertRaisesRegex(ValueError, "action semantics differ"):
                    runpy.run_path(str(config), run_name="__main__")
                self.assertFalse(output.exists())

    def robotwin_recipe(self, recipe):
        config = load("benchmarks/robotwin/configure_robotwin.py")
        profile = json.loads((ADAPTER / "profiles/robotwin-demo-clean.json").read_text())
        args = Namespace(suite=None, recipe=recipe, robotwin_source=ADAPTER, assets=ADAPTER, benchmark_image="test:sim")
        with patch.object(config, "check_source"), patch.object(config, "tree_digest", return_value="test-assets"), \
                patch.object(config, "image_id", return_value="test:sim"), patch.object(config, "implementation_digest"):
            return json.loads(config.configure_benchmark(args, profile)["config"]["reference"])

    def test_hy_vla_registration_rejects_wrong_quaternion_and_action_order(self):
        self.assert_action_policy_registration("hy-embodied-vla/configure_hy_vla.py",
                                               self.robotwin_recipe("absolute-ee"), "ee_pose", "order",
                                               [part for arm in ("left", "right") for part in
                                                (f"{arm}_x", f"{arm}_y", f"{arm}_z", f"{arm}_qx",
                                                 f"{arm}_qy", f"{arm}_qz", f"{arm}_qw", f"{arm}_gripper")])

    def test_motus_registration_rejects_wrong_camera_and_action_order(self):
        self.assert_action_policy_registration("motus/configure_motus.py", self.robotwin_recipe("qpos-chunk-16"),
                                               "head_camera", "camera", "left_camera")

    def test_robomme_pi05_registration_rejects_wrong_state_units_and_action_order(self):
        config = load("benchmarks/robomme/configure_robomme.py")
        with patch.object(config, "test_catalog", return_value={}):
            reference = config.reference(ADAPTER)
        self.assert_action_policy_registration("robomme-pi05/configure_robomme_pi05.py", reference,
                                               "joint_state", "unit", "degrees-and-meters")

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

    def test_model_action_decoders_validate_raw_values_before_float32_conversion(self):
        from orbit_embodied import EpisodeFailure

        dm05 = load("policies/dm05/serve_dm05.py")
        gigaworld = load("policies/gigaworld-policy-01/serve_gigaworld.py")
        for convert, shape in ((dm05.native_actions, (20, 7)), (gigaworld.native_chunk, (24, 12))):
            with self.subTest(decoder=convert.__name__):
                self.assertEqual(convert(np.zeros(shape, dtype=np.float64)).dtype, np.float32)
                for raw, reason in (
                    (np.full(shape, "0.25"), "invalid shape"),
                    (np.full(shape, 1 + 2j), "invalid shape"),
                    (np.full(shape, np.inf), "non-finite"),
                    (np.full(shape, 1e100), "after conversion to float32"),
                ):
                    with self.assertRaisesRegex(EpisodeFailure, reason) as failure:
                        convert(raw)
                    self.assertEqual(failure.exception.kind, "policy_act")
                    np.testing.assert_array_equal(failure.exception.rejected_actions, raw, strict=True)

    def test_droid_registration_requires_its_build_manifest_and_entrypoint(self):
        config = load("policies/openpi/configure_droid.py")
        molmo = load("benchmarks/molmospaces/configure_molmospaces.py")
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
            benchmark = molmo.profile()
            reference.write_text(json.dumps({
                "benchmarkProfile": benchmark, "environment": {"kind": "molmospaces"},
                "parameters": {"replanSteps": 8},
                "observationMap": {name: name for name in benchmark["observations"]},
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
            reference = {"benchmarkProfile": randcam, "environment": {"kind": "molmospaces", "frontCamera": camera},
                         "observationMap": observation_map,
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

    def test_lingbot_and_droid_registration_reject_camera_and_action_order_mismatches(self):
        lingbot = load("policies/lingbot-vla/configure_lingbot.py")
        droid = load("policies/openpi/configure_droid.py")
        molmo = load("benchmarks/molmospaces/configure_molmospaces.py")
        standard = molmo.profile()
        standard_reference = {"benchmarkProfile": standard, "environment": {"kind": "molmospaces"},
                              "observationMap": {name: name for name in standard["observations"]},
                              "parameters": {"replanSteps": 8}}
        randcam_reference = copy.deepcopy(standard_reference)
        randcam_reference["benchmarkProfile"]["id"] = "molmospaces-franka-droid-exocentric/1"
        randcam_reference["benchmarkProfile"]["observations"]["front_rgb"]["camera"] = "randomized_zed2_analogue_1"
        randcam_reference["environment"]["frontCamera"] = "randomized_zed2_analogue_1"
        robotwin_reference = json.loads((ADAPTER / "profiles/robotwin-demo-clean.json").read_text())

        for config, reference, camera, expected_id in (
            (lingbot, robotwin_reference, "head_camera", "lingbot-vla-robotwin-joint-input/1"),
            (droid, standard_reference, "front_rgb", "pi05-droid-jointpos-input/1"),
            (droid, randcam_reference, "wrist_rgb", "pi05-droid-jointpos-randcam-input/1"),
        ):
            with self.subTest(profile=expected_id):
                benchmark = reference["benchmarkProfile"]
                self.assertEqual(config.policy_profile(reference), {**benchmark, "id": expected_id})
                changed = copy.deepcopy(reference)
                changed["benchmarkProfile"]["observations"][camera]["camera"] = "wrong-camera"
                with self.assertRaisesRegex(ValueError, "incompatible semantics for " + camera):
                    config.policy_profile(changed)
                changed = copy.deepcopy(reference)
                changed["benchmarkProfile"]["action"]["order"].reverse()
                with self.assertRaisesRegex(ValueError, "action semantics differ"):
                    config.policy_profile(changed)
        standard_reference["environment"]["frontCamera"] = "wrong-camera"
        with self.assertRaisesRegex(ValueError, "requires the native shoulder camera"):
            droid.policy_profile(standard_reference)

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
                   "trialId": "trial", "implementationDigest": "test", "referenceDigest": digest}
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
