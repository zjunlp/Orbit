"""RoboLab protocol checks with explicit synthetic native environments and assets."""

import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

import numpy as np

from orbit_embodied import robolab
from orbit_embodied.binding import digest, resolve_binding, seed_asset, validate_observation

HERE = Path(__file__).resolve().parents[2] / "bench-adapters/embodied"
sys.path.insert(0, str(HERE))
import configure_robolab as configure


def reference():
    ref = json.loads(configure.PROFILE.read_text())
    ref["environment"]["assets"]["digest"] = "sha256:" + "a" * 64
    return ref


def sample(ref, task="BananaInBowlTask"):
    return {"taskId": task, "environmentSeed": 7, "initialStateId": "2",
            "initialStateDigest": seed_asset(ref, task)}


def observation(value=0):
    rgb = np.full((1, 720, 1280, 3), value, dtype=np.uint8)
    return {"image_obs": {"over_shoulder_left_camera": rgb, "wrist_cam": rgb},
            "proprio_obs": {"arm_joint_pos": np.zeros((1, 7), dtype=np.float32),
                            "gripper_pos": np.zeros((1, 1), dtype=np.float32)}}


class Tensor:
    def __init__(self, value):
        self.value = np.asarray(value)

    def unsqueeze(self, axis):
        return np.expand_dims(self.value, axis)


class SyntheticNative:
    device = "cpu"

    def __init__(self):
        self.resets, self.closed = 0, False
        self.all_terminated, self.success = False, None
        self.native_flags = (False, False)
        self.raw = observation()

    def reset(self):
        self.resets += 1
        self.raw = observation(self.resets)
        return self.raw, {}

    def step(self, action):
        self.action = action.copy()
        return self.raw, np.array([0.0]), *self.native_flags, {}

    def get_env_results(self):
        return [{"env_id": 0, "success": self.success, "step": 3 if self.all_terminated else None}]

    def close(self):
        self.closed = True


class RoboLabTests(unittest.TestCase):
    def setUp(self):
        self.ref = reference()
        self.benchmark = robolab.RoboLabBenchmark(self.ref, "BananaInBowlTask")
        self.native = SyntheticNative()
        self.benchmark.env = self.native
        self.torch = patch.dict(sys.modules, {"torch": SimpleNamespace(
            as_tensor=lambda value, device: Tensor(value))})
        self.torch.start()
        self.addCleanup(self.torch.stop)

    def test_hold_fixture_preserves_native_joint_units_and_binary_gripper(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("hold_robolab", HERE / "fixtures/hold_robolab.py")
        fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture)
        joints = np.array([0.1, -0.2, 0.3, -1.8, 0.2, 1.5, 0.7], dtype=np.float32)
        for gripper, expected in ((0.2, 0), (0.8, 1)):
            actions = fixture.hold({"joint_position": joints, "gripper_position": [gripper]}, 15)
            self.assertEqual(actions.shape, (15, 8))
            np.testing.assert_array_equal(actions[:, :7], np.repeat(joints[None], 15, axis=0))
            self.assertTrue(np.all(actions[:, -1] == expected))
        definition = configure.hold_policy(self.ref, "sha256:" + "b" * 64)
        self.assertEqual(definition["kind"], "calibration")
        self.assertEqual(definition["normalizationDigest"], fixture.NORMALIZATION)
        self.assertEqual(definition["service"]["gpus"], 0)

    def test_catalog_and_semantics_match_native_droid_recipe(self):
        env = self.ref["environment"]
        self.assertEqual(len(set(env["tasks"])), 120)
        self.assertEqual(set(env["tasks"]), set(env["horizons"]))
        self.assertEqual(env["horizons"]["BananaInBowlTask"], 750)
        self.assertEqual(env["horizons"]["RubiksCubeAndBananaTask"], 900)
        self.assertEqual(env["controlHz"] * env["decimation"], env["physicsHz"])
        native = self.ref["benchmarkProfile"]
        resolve_binding(native, native, self.ref["observationMap"])
        self.assertEqual(native["action"]["shape"], [8])
        self.assertEqual(native["action"]["controller"], "DroidJointPositionActionCfg")

    def test_reset_uses_frozen_seed_and_second_native_observation(self):
        with patch.object(self.benchmark, "make_env", return_value=self.native) as create:
            result = self.benchmark.reset(sample(self.ref))
        create.assert_called_once_with(9)
        self.assertEqual(self.native.resets, 2)
        self.assertEqual(result["front_rgb"][0, 0, 0], 2)
        validate_observation(result, self.ref["benchmarkProfile"]["observations"])
        self.native.raw["image_obs"]["over_shoulder_left_camera"].fill(0)
        self.assertEqual(result["front_rgb"][0, 0, 0], 2)
        self.assertEqual(result["instruction"], "Pick up the banana and place it in the bowl")

    def test_reset_rejects_bad_seed_before_starting_isaac(self):
        item = sample(self.ref)
        item["environmentSeed"] = 2 ** 32 - 1
        with patch.object(self.benchmark, "make_env") as create, self.assertRaisesRegex(ValueError, "32"):
            self.benchmark.reset(item)
        create.assert_not_called()

    def test_early_physics_artifact_does_not_count_as_native_success(self):
        self.native.native_flags = (True, False)
        action = np.array([0.0, -0.2, 0.1, -1.5, 0.2, 1.5, 0.3, 0.8])
        result = self.benchmark.step(action)
        self.assertFalse(result.terminated)
        self.assertFalse(result.success)
        np.testing.assert_array_equal(self.native.action, action.astype(np.float32)[None])
        self.native.all_terminated, self.native.success = True, True
        result = self.benchmark.step(action)
        self.assertTrue(result.terminated)
        self.assertTrue(result.success)
        self.assertTrue(self.benchmark.result()["success"])
        self.assertEqual(result.simulation_time, 2 / 15)

    def test_native_timeout_is_a_scored_failure(self):
        self.native.all_terminated, self.native.success = True, False
        self.native.native_flags = (False, True)
        result = self.benchmark.step(np.zeros(8))
        self.assertTrue(result.terminated)
        self.assertFalse(result.success)
        self.assertFalse(self.benchmark.result()["success"])

    def test_no_native_verdict_is_invalid_instead_of_a_scored_failure(self):
        self.benchmark.step(np.zeros(8))
        with self.assertRaisesRegex(ValueError, "without a native terminal result"):
            self.benchmark.result()
        self.native.all_terminated = True
        with self.assertRaisesRegex(ValueError, "disagree"):
            self.benchmark.step(np.zeros(8))

    def test_application_survives_environment_close_and_next_episode(self):
        launcher = MagicMock()
        app_module = SimpleNamespace(AppLauncher=launcher)
        with patch.object(robolab, "_APP", None), patch.dict(sys.modules, {
                "isaaclab": SimpleNamespace(), "isaaclab.app": app_module, "cv2": SimpleNamespace()}), \
                patch.object(robolab.atexit, "register") as at_exit, \
                patch.object(robolab, "driver_version_kit_args", return_value="synthetic-kit-argument"):
            first = robolab.simulation_app()
            self.benchmark.close()
            second = robolab.simulation_app()
        self.assertIs(first, second)
        launcher.assert_called_once_with(headless=True, enable_cameras=True, device="cuda:0",
                                         kit_args="synthetic-kit-argument")
        at_exit.assert_called_once_with(first.close)
        first.close.assert_not_called()
        self.assertTrue(self.native.closed)

    def test_real_hdf5_is_closed_before_sealing_with_synthetic_simulator(self):
        try:
            import h5py
        except ImportError:
            self.skipTest("optional h5py is required for the real file lifecycle check")
        from orbit_embodied import run_episode, verify_episode
        from orbit_embodied.test_core import CoreTests, SyntheticBenchmark, SyntheticPolicy

        for fail_at in (None, 1):
            with self.subTest(fail_at=fail_at):
                core = CoreTests()
                core.setUp()
                self.addCleanup(core.tearDown)
                test = self

                class Recorded(SyntheticBenchmark):
                    finalize_evidence = robolab.RoboLabBenchmark.finalize_evidence

                    def reset(self, item):
                        self.file = h5py.File(core.output / "native.hdf5", "w")
                        self.file["synthetic_steps"] = [1, 2]
                        self.file.flush()
                        self.env = SimpleNamespace(recorder_manager=SimpleNamespace(
                            _dataset_file_handler=self.file, _failed_episode_dataset_file_handler=None))
                        return super().reset(item)

                    def finish_video(self):
                        test.assertFalse(self.file.id.valid)
                        test.assertEqual(verify_episode(core.output, core.sample["sampleId"],
                                                       "synthetic-trial.attempt")["valid"], fail_at is None)

                    def close(self):
                        self.file.close()
                        super().close()

                result = run_episode(Recorded(success_at=2, fail_at=fail_at), SyntheticPolicy(), core.sample,
                                     core.binding, core.output, "synthetic-trial.attempt", {"fixture": True},
                                     seal_before_media=True)
                self.assertEqual(result, verify_episode(core.output, core.sample["sampleId"],
                                                        "synthetic-trial.attempt"))
                self.assertEqual(result["valid"], fail_at is None)

    def test_runtime_uses_package_version_instead_of_release_tag(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "VERSION").write_text("5.0.0-rc.1")
            ref = reference()
            ref["environment"].update(sourceRoot=str(root), isaacSimVersionFile=str(root / "VERSION"))
            ref["environment"]["assets"]["target"] = str(root / "assets")
            with patch.object(robolab, "check_assets"), patch.object(robolab, "version", return_value="0.44.8"), \
                    patch.object(robolab, "isaaclab_source_digest", return_value=ref["environment"]["isaacLabSource"]["digest"]):
                robolab.check_runtime(ref)
            with patch.object(robolab, "check_assets"), patch.object(robolab, "version", return_value="2.2.0"), \
                    self.assertRaisesRegex(ValueError, "Isaac Lab differs"):
                robolab.check_runtime(ref)

    def test_runtime_rejects_source_change_with_matching_package_version(self):
        ref = reference()
        with patch.object(robolab, "check_assets"), patch.object(robolab, "version", return_value="0.44.8"), \
                patch.object(robolab, "isaaclab_source_digest", return_value="sha256:" + "b" * 64), \
                self.assertRaisesRegex(ValueError, "Isaac Lab source differs"):
            robolab.check_runtime(ref)

    def test_assets_reject_lfs_pointers_and_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "scene.usda"
            path.write_text("version https://git-lfs.github.com/spec/v1\noid sha256:" + "a" * 64 + "\nsize 1\n")
            with self.assertRaisesRegex(ValueError, "LFS pointer"):
                robolab.check_assets(temporary)
            path.write_text("synthetic asset")
            expected = robolab.check_assets(temporary)
            path.write_text("changed synthetic asset")
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                robolab.check_assets(temporary, expected)

    def test_published_assets_hash_the_lfs_object_not_the_pointer(self):
        import hashlib
        data = b"synthetic USD asset"
        checksum = "sha256:" + hashlib.sha256(data).hexdigest()
        pointer = f"version https://git-lfs.github.com/spec/v1\noid {checksum}\nsize {len(data)}\n".encode()
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w") as stream:
            info = tarfile.TarInfo("assets/scenes/example.usda")
            info.size = len(pointer)
            stream.addfile(info, io.BytesIO(pointer))
        with patch.object(configure.subprocess, "check_output", return_value=archive.getvalue()):
            expected = configure.published_asset_digest(Path("/synthetic/source"))
        self.assertEqual(expected, digest([{"path": "scenes/example.usda", "size": len(data), "digest": checksum}]))

    def test_published_assets_match_runtime_path_component_order(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "material").mkdir()
            (root / "material/texture.png").write_bytes(b"synthetic texture")
            (root / "material.mdl").write_bytes(b"synthetic material")
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode="w") as stream:
                for path in root.rglob("*"):
                    if path.is_file():
                        stream.add(path, arcname="assets/" + path.relative_to(root).as_posix())
            with patch.object(configure.subprocess, "check_output", return_value=archive.getvalue()):
                expected = configure.published_asset_digest(Path("/synthetic/source"))
            self.assertEqual(robolab.check_assets(root), expected)

    def test_benchmark_only_registration_binds_resources_and_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args = ["configure_robolab.py", "--robolab-source", "/synthetic/source",
                    "--assets", "/synthetic/assets", "--benchmark-image", "synthetic",
                    "--benchmark-only", "--output-dir", str(root)]
            with patch.object(configure, "reference_for", return_value=self.ref), \
                    patch.object(configure, "image_id", return_value="sha256:" + "b" * 64), \
                    patch.object(sys, "argv", args):
                configure.main()
            registration = json.loads((root / "benchmark.json").read_text())
            self.assertEqual(registration["resources"], str(root / "resources.json"))
            self.assertEqual(registration["labels"]["identity"], {"id": "robolab", "name": "RoboLab"})
            self.assertEqual(registration["config"]["profileDigest"], digest(self.ref))
            self.assertFalse((root / "policy.json").exists())
            self.assertEqual(json.loads((root / "resources.json").read_text())["default"]["gpus"], 1)


if __name__ == "__main__":
    unittest.main()
