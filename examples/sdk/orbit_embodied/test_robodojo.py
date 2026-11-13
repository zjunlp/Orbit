"""Metadata checks and explicit synthetic native-environment unit tests; no simulator."""

import json
import os
import subprocess
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import numpy as np

from orbit_embodied import robodojo
from orbit_embodied.binding import file_digest, robodojo_layout, reset_seed
from orbit_embodied.driver import SampleRejected
from orbit_embodied.robodojo import RoboDojoBenchmark, OrbitPolicyLifecycle, create_native_env, joint_action

ADAPTER = Path(__file__).resolve().parents[2] / "bench-adapters/embodied"
sys.path.insert(0, str(ADAPTER / "benchmarks/robodojo"))
import configure_robodojo
sys.path.insert(0, str(ADAPTER / "fixtures"))
import hold_robodojo


def reference():
    return json.loads((ADAPTER / "profiles/robodojo-native.json").read_text())


class RoboDojoTests(unittest.TestCase):
    def test_full_pinned_catalog_and_original_horizons(self):
        profile = reference()
        catalog = profile["environment"]["catalog"]
        self.assertEqual(len(catalog), 54)
        self.assertEqual(sum(item["variant"] == "random" for item in catalog.values()), 12)
        self.assertEqual(catalog["push_T"]["horizon"], 600)
        self.assertEqual(catalog["stack_bowls"]["horizon"], 800)
        self.assertFalse(catalog["push_T"]["partialScore"])
        self.assertTrue(catalog["stack_bowls"]["partialScore"])
        self.assertEqual(set(catalog), set(profile["environment"]["horizons"]))
        for task in catalog:
            self.assertIn("task/RoboDojo/tasks/" + task + ".py", profile["reference"]["files"])
            self.assertIn("task/RoboDojo/config/" + task + ".yml", profile["reference"]["files"])

    @unittest.skipUnless(os.environ.get("ORBIT_ROBODOJO_SOURCE"), "set ORBIT_ROBODOJO_SOURCE for official checkout checks")
    def test_real_upstream_metadata_without_simulator_import(self):
        root = Path(os.environ["ORBIT_ROBODOJO_SOURCE"])
        profile = reference()
        for task, catalog in profile["environment"]["catalog"].items():
            native = configure_robodojo.task_metadata(root, task)
            self.assertEqual(native, {key: catalog[key] for key in native})
        for name, expected in profile["reference"]["files"].items():
            self.assertEqual(file_digest(root / name), expected, name)

    def test_layout_ordinals_use_numeric_order_and_keep_all_tasks(self):
        with tempfile.TemporaryDirectory() as directory:
            assets = Path(directory)
            for seed in (0, 2):
                folder = assets / "Eval_Layout/RoboDojo/arx_x5" / str(seed)
                folder.mkdir(parents=True)
                for suffix in (10, 2):
                    (folder / f"push_T_{suffix}.json").write_text(json.dumps({"Rigid": {"synthetic": seed}}))
                (folder / "push_T_random_1.json").write_text('{}')
            layouts, unsupported = configure_robodojo.layout_catalog(assets, ["push_T", "stack_bowls"])
            self.assertEqual([item["id"] for item in layouts["push_T"]["2"]], [0, 1])
            self.assertTrue(layouts["push_T"]["2"][0]["file"].endswith("push_T_2.json"))
            self.assertTrue(layouts["push_T"]["2"][1]["file"].endswith("push_T_10.json"))
            self.assertEqual(layouts["push_T"]["1"], [])
            self.assertIn("stack_bowls", unsupported)
            profile = reference()
            profile["environment"]["layouts"] = layouts
            sample = {"taskId": "push_T", "environmentSeed": 2, "initialStateId": "1"}
            self.assertEqual(reset_seed(sample, profile), 2)
            self.assertEqual(robodojo_layout(profile, "push_T", 2, 1), layouts["push_T"]["2"][1])
            with self.assertRaises(ValueError):
                robodojo_layout(profile, "push_T", 1, 0)

    def test_ambiguous_layout_suffix_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            assets = Path(directory)
            folder = assets / "Eval_Layout/RoboDojo/arx_x5/0"
            folder.mkdir(parents=True)
            for name in ("push_T_1.json", "push_T_01.json"):
                (folder / name).write_text('{"Rigid":{}}')
            with self.assertRaisesRegex(ValueError, "ambiguous"):
                configure_robodojo.layout_catalog(assets, ["push_T"])

    def test_transport_delegation_leaves_original_factory_globals_intact(self):
        namespace = {"WsModelClient": object}
        exec("def create_eval_env(config, app):\n    return WsModelClient(url='unused')\n", namespace)
        module = SimpleNamespace(create_eval_env=namespace["create_eval_env"])
        result = create_native_env(module, {}, None)
        self.assertIsInstance(result, OrbitPolicyLifecycle)
        result.call(func_name="reset")
        self.assertEqual(result.resets, 1)
        with self.assertRaises(RuntimeError):
            result.call(func_name="predict")
        self.assertIs(namespace["WsModelClient"], object)

    def test_driver_workaround_preserves_native_zero_delay_args(self):
        app = SimpleNamespace(close=Mock())
        launcher = Mock(return_value=SimpleNamespace(app=app))
        monitor = Mock()
        def zero_delay(args):
            args.kit_args = "--/app/renderer/waitIdle=true"
        modules = {
            "src.eval_client.physx_warning_monitor": SimpleNamespace(get_monitor=lambda: monitor),
            "env.camera_manager.capture.render_sync": SimpleNamespace(add_zero_delay_kit_args=zero_delay),
            "isaaclab.app": SimpleNamespace(AppLauncher=launcher),
        }
        with patch.object(robodojo, "_APP", None), patch.dict(sys.modules, modules), \
                patch.object(robodojo, "driver_version_kit_args", return_value="synthetic-workaround"), \
                patch.object(robodojo.atexit, "register"), \
                patch.object(robodojo, "prepare_native_imports") as prepare:
            self.assertIs(robodojo.simulation_app(), app)
            self.assertIs(robodojo.simulation_app(), app)
        prepare.assert_called_once()
        launcher.assert_called_once()
        self.assertEqual(launcher.call_args.args[0].kit_args,
                         "--/app/renderer/waitIdle=true synthetic-workaround")
        monitor.start.assert_called_once_with(enabled=True)

    def test_native_namespace_survives_later_opencv_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            native = root / "native"
            foreign = root / "opencv"
            (native / "utils").mkdir(parents=True)
            (foreign / "utils").mkdir(parents=True)
            (native / "utils/load_file.py").write_text("origin = 'native'\n")
            (native / "utils/pipeline_utils.py").write_text("origin = 'native'\n")
            (foreign / "utils/__init__.py").write_text("origin = 'opencv'\n")
            code = """
import importlib, sys
from pathlib import Path
from orbit_embodied import robodojo
robodojo.ROOT = Path(sys.argv[1])
sys.path.insert(0, sys.argv[1])
robodojo.prepare_native_imports()
sys.path.insert(0, sys.argv[2])
assert importlib.import_module('utils.pipeline_utils').origin == 'native'
"""
            subprocess.run([sys.executable, "-c", code, str(native), str(foreign)], check=True)

    def test_foreign_utils_are_rejected_without_overwriting_modules(self):
        foreign = SimpleNamespace(__file__="/foreign/utils/load_file.py")
        with patch.dict(sys.modules, {"utils.load_file": foreign}):
            with self.assertRaisesRegex(RuntimeError, "outside the frozen"):
                robodojo.prepare_native_imports()
            self.assertIs(sys.modules["utils.load_file"], foreign)

    def test_native_joint_targets_preserve_order_and_gripper_clipping_owner(self):
        targets = joint_action(np.arange(14, dtype=float))
        self.assertEqual(targets["left_arm_joint_state"], list(range(6)))
        self.assertEqual(targets["left_ee_joint_state"], [6])
        self.assertEqual(targets["right_arm_joint_state"], list(range(7, 13)))
        self.assertEqual(targets["right_ee_joint_state"], [13])
        with self.assertRaises(ValueError):
            joint_action(np.zeros(7))
        with self.assertRaises(ValueError):
            joint_action(np.full(14, np.nan))

    def test_asset_pointers_are_rejected_before_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "robot.usd"
            path.write_text("version https://git-lfs.github.com/spec/v1\noid sha256:synthetic\nsize 9999\n")
            with self.assertRaisesRegex(ValueError, "Git LFS pointer"):
                configure_robodojo.reject_asset_pointers(Path(directory))
            path.write_bytes(b"synthetic usd")
            configure_robodojo.reject_asset_pointers(Path(directory))

    def test_native_asset_config_uses_container_paths_and_preserves_custom_files(self):
        with tempfile.TemporaryDirectory() as directory:
            assets = Path(directory)
            template = assets / "Robots/x5/curobo_tmp.yml"
            template.parent.mkdir(parents=True)
            template.write_text("asset: ${ASSETS_PATH}/Assets/Robots/x5\nurdf: $ASSETS_PATH/Assets/x5.urdf\nradius: 0.125\n")
            target = template.with_name("curobo.yml")
            with self.assertRaisesRegex(ValueError, "--prepare-assets"):
                configure_robodojo.prepare_asset_config(assets, reference())
            receipt = configure_robodojo.prepare_asset_config(assets, reference(), write=True)
            expected = "asset: /workspace/RoboDojo/Assets/Robots/x5\nurdf: /workspace/RoboDojo/Assets/x5.urdf\nradius: 0.125\n"
            self.assertEqual(target.read_text(), expected)
            self.assertEqual(receipt["generated"]["digest"], file_digest(target))
            self.assertEqual(configure_robodojo.prepare_asset_config(assets, reference()), receipt)
            target.write_text("custom configuration\n")
            with self.assertRaisesRegex(ValueError, "preserve it"):
                configure_robodojo.prepare_asset_config(assets, reference(), write=True)
            self.assertEqual(target.read_text(), "custom configuration\n")

    def test_hold_fixture_repeats_native_state_without_model_identity(self):
        values = np.arange(14, dtype=np.float32) / 20
        np.testing.assert_array_equal(hold_robodojo.hold({"joint_state": values}, 2), np.stack([values, values]))
        policy = configure_robodojo.hold_policy(reference(), "sha256:" + "a" * 64)
        self.assertEqual(policy["kind"], "calibration")
        self.assertEqual(policy["service"]["gpus"], 0)
        self.assertEqual(policy["normalizationDigest"], hold_robodojo.NORMALIZATION)
        self.assertEqual(policy["checkpointDigest"], file_digest(ADAPTER / "fixtures/hold_robodojo.py"))
        with self.assertRaises(ValueError):
            hold_robodojo.hold({"joint_state": np.zeros(7)}, 1)

    def test_dependency_manifest_checks_commit_and_content(self):
        profile = reference()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for relative, scopes in configure_robodojo.DEPENDENCIES.values():
                for scope in scopes:
                    path = root / relative / scope
                    if not path.suffix:
                        path = path / "native.py"
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("# synthetic dependency source\n")
            geometry = root / "third_party/curobo/curobo/robot.STL"
            geometry.write_bytes(b"synthetic robot geometry")
            def git(arguments, **_kwargs):
                folder = Path(arguments[2]).relative_to(root).as_posix()
                key = next(key for key, (relative, _scopes) in configure_robodojo.DEPENDENCIES.items() if relative == folder)
                if "rev-parse" in arguments:
                    return profile["reference"][key]["commit"] + "\n"
                if "status" in arguments:
                    return ""
                return "\n".join(path.relative_to(root / folder).as_posix()
                                  for path in (root / folder).rglob("*") if path.is_file()) + "\n"
            with patch.object(configure_robodojo, "check_source"), \
                    patch.object(configure_robodojo.subprocess, "check_output", side_effect=git):
                manifest = configure_robodojo.runtime_manifest(root, profile)
            with patch.object(configure_robodojo, "check_source"), \
                    patch.object(configure_robodojo.subprocess, "check_output", side_effect=git):
                package = root / "third_party/curobo/curobo"
                package.rename(root / "held-package")
                with self.assertRaisesRegex(ValueError, "missing dependency runtime scope"):
                    configure_robodojo.runtime_manifest(root, profile)
                (root / "held-package").rename(package)
            self.assertIn("third_party/curobo/curobo/robot.STL", manifest["files"])
            self.assertEqual(manifest["isaacsim"], "5.1.0")
            self.assertEqual(len(manifest["commits"]), 3)
            for name, value in manifest["files"].items():
                self.assertEqual(value, file_digest(root / name))
            with patch.object(configure_robodojo, "check_source"), \
                    patch.object(configure_robodojo.subprocess, "check_output", return_value="wrong-commit"):
                with self.assertRaisesRegex(ValueError, "pinned RoboDojo submodule"):
                    configure_robodojo.runtime_manifest(root, profile)

    def benchmark(self):
        benchmark = RoboDojoBenchmark(reference(), "stack_bowls")
        benchmark.layout = {"evalSeed": 0, "id": 0, "file": "synthetic", "digest": "synthetic"}
        benchmark.env = SimpleNamespace(end_flag=[False], success=[True], unstable_envs=set(), take_action_cnt=[0],
                                        get_score=lambda: None, reward_manager=SimpleNamespace(get_score=lambda: [25]))
        return benchmark

    def test_initial_alive_flag_is_not_success_and_partial_score_survives(self):
        benchmark = self.benchmark()
        self.assertFalse(benchmark.native_state()["nativeSuccess"])
        with self.assertRaises(ValueError):
            benchmark.result()
        benchmark.env.end_flag[0] = True
        benchmark.env.success[0] = False
        benchmark.env.take_action_cnt[0] = 800
        self.assertEqual(benchmark.result()["score"], 0.25)
        benchmark.env.success[0] = True
        self.assertEqual(benchmark.result()["score"], 1.0)

    def test_native_early_terminal_failure_and_mid_episode_unstable(self):
        benchmark = self.benchmark()
        def take_action(_action):
            benchmark.env.take_action_cnt[0] += 1
            benchmark.env.end_flag[0] = True
            benchmark.env.success[0] = False
        benchmark.env.take_action = take_action
        benchmark.env.get_obs = lambda: {"synthetic": True}
        with patch.object(benchmark, "observation", side_effect=lambda raw: raw):
            step = benchmark.step(np.zeros(14))
        self.assertTrue(step.terminated)
        self.assertFalse(step.success)
        self.assertEqual(benchmark.env.take_action_cnt, [1])
        benchmark.env.end_flag[0] = False
        benchmark.env.unstable_envs.add(0)
        with self.assertRaises(SampleRejected):
            benchmark.step(np.zeros(14))

    def test_native_terminal_action_is_not_executed_twice(self):
        benchmark = self.benchmark()
        benchmark.env.end_flag[0] = True
        benchmark.env.take_action = Mock()
        with self.assertRaises(RuntimeError):
            benchmark.step(np.zeros(14))
        benchmark.env.take_action.assert_not_called()

    def test_nonfinite_native_score_is_invalid(self):
        benchmark = self.benchmark()
        for score in (float('nan'), float('inf'), -1, 101):
            benchmark.env.reward_manager.get_score = lambda: [score]
            with self.assertRaises(ValueError):
                benchmark.native_state()


if __name__ == "__main__":
    unittest.main()
