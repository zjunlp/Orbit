"""Coverage and seed-plan checks with synthetic RoboTwin inputs."""

from argparse import Namespace
import json
from pathlib import Path
import sys
import tempfile
from types import ModuleType
import unittest
from unittest.mock import Mock, patch

from orbit_embodied.binding import digest
from orbit_embodied.robotwin import RoboTwinBenchmark, setup_native_scene

ADAPTER = Path(__file__).resolve().parents[2] / "bench-adapters/embodied"
sys.path.insert(0, str(ADAPTER))
import configure_robotwin
import plan_robotwin


def reference():
    return json.loads((ADAPTER / "profiles/robotwin-demo-clean.json").read_text())


class RobotwinTests(unittest.TestCase):
    def test_task_name_instructions_bypass_episode_descriptions(self):
        profile = reference()
        benchmark = RoboTwinBenchmark(profile, "adjust_bottle")
        benchmark.seed = 1
        generator = ModuleType("generate_episode_instructions")
        generator.generate_episode_descriptions = Mock(return_value=[{"unseen": ["Episode instruction"]}])
        with patch.dict(sys.modules, {generator.__name__: generator}):
            profile["environment"]["instructionMode"] = "task-name"
            self.assertEqual(benchmark._instruction({}), "adjust bottle")
            generator.generate_episode_descriptions.assert_not_called()
            del profile["environment"]["instructionMode"]
            self.assertEqual(benchmark._instruction({}), "Episode instruction")

    def test_randomized_setups_use_fresh_clutter_bounds(self):
        class NativeEnvironment:
            def __init__(self):
                self.bounds = []

            def setup_demo(self, *, seed, **_settings):
                self.seed = seed
                self.get_cluttered_table()

            def get_cluttered_table(self, xlim=[-0.59, 0.59], ylim=[-0.34, 0.34]):
                xlim[0] += 0.3
                xlim[1] += 0.3
                self.bounds.append((self.seed, xlim, ylim))

        env = NativeEnvironment()
        for _ in range(2):
            setup_native_scene(env, 100000, {"domain_randomization": {"cluttered_table": True}})
            self.assertNotIn("get_cluttered_table", vars(env))
        self.assertEqual(env.bounds[0], env.bounds[1])
        self.assertIsNot(env.bounds[0][1], env.bounds[1][1])
        self.assertEqual(NativeEnvironment.get_cluttered_table.__defaults__, ([-0.59, 0.59], [-0.34, 0.34]))

    def test_suite_registration_freezes_catalog_limits_and_separate_identities(self):
        config = json.loads((ADAPTER / "profiles/robotwin-suites.json").read_text())
        tasks = {"adjust_bottle": 400, **{"synthetic_" + str(i): 401 + i for i in range(49)}}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "task_config").mkdir()
            (root / "task_config/_eval_step_limit.yml").write_text(
                "".join(f"{task}: {limit}\n" for task, limit in tasks.items()))
            for suite in (None, "demo_clean", "demo_randomized"):
                with self.subTest(suite=suite), patch.object(configure_robotwin, "check_source"), \
                        patch.object(configure_robotwin, "image_id", return_value="synthetic"), \
                        patch.object(configure_robotwin, "implementation_digest", return_value="synthetic"), \
                        patch.object(configure_robotwin.subprocess, "run"), \
                        patch.object(configure_robotwin, "file_digest", return_value="synthetic"), \
                        patch.object(configure_robotwin, "tree_digest",
                                     return_value=config["assetDigests"].get(suite, "synthetic")):
                    args = Namespace(suite=suite, robotwin_source=root, assets=root, benchmark_image="synthetic")
                    registration = configure_robotwin.configure_benchmark(args, reference())
                    profile = json.loads(registration["config"]["reference"])
                    environment = profile["environment"]
                    if suite is None:
                        self.assertEqual(registration["name"], "robotwin-demo-clean-native")
                        self.assertEqual(environment["tasks"], ["adjust_bottle"])
                        self.assertEqual(profile["scoreUnit"], "sample")
                        continue
                    self.assertEqual(registration["name"], "robotwin-" + suite.replace("_", "-") + "-full-native")
                    self.assertEqual(environment["tasks"], list(tasks))
                    self.assertEqual(environment["horizons"], tasks)
                    self.assertEqual(profile["scoreUnit"], "task")
                    self.assertEqual("task_config/demo_randomized.yml" in profile["reference"]["files"],
                                     suite == "demo_randomized")
                    self.assertEqual("background_texture.zip" in profile["reference"]["assets"]["archives"],
                                     suite == "demo_randomized")

    def test_expert_plan_selects_first_accepted_seeds_in_task_order(self):
        profile = reference()
        profile["environment"]["tasks"].append("beat_block_hammer")
        profile["environment"]["assets"]["digest"] = "synthetic"
        tasks = ["beat_block_hammer", "adjust_bottle"]
        with patch.object(plan_robotwin, "RoboTwinBenchmark") as benchmark:
            benchmark.return_value.expert_accepts.side_effect = lambda seed, _candidate: seed % 2 == 1
            plan = plan_robotwin.sample_plan(profile, tasks, 1, 2, 4)
            self.assertEqual(benchmark.call_count, 2)
            self.assertEqual([item["taskId"] for item in plan["items"]], [tasks[0]] * 2 + [tasks[1]] * 2)
            self.assertEqual([item["initialStateId"] for item in plan["items"]], ["1", "3"] * 2)
            self.assertEqual({item["environmentSeed"] for item in plan["items"]}, {200000})
            self.assertEqual(len({item["sampleId"] for item in plan["items"]}), 4)
            self.assertEqual(plan["digest"], digest(plan["items"]))
            with self.assertRaisesRegex(ValueError, "only 1 of 2 expert-accepted"):
                plan_robotwin.sample_plan(profile, tasks, 1, 2, 3)

    def test_expert_plan_skips_missing_grasp_pose_but_propagates_other_errors(self):
        action = ModuleType("envs.utils.action")
        exec('def __init__():\n    raise AssertionError("target_pose cannot be None for move action.")', vars(action))
        base_task = ModuleType("envs._base_task")
        base_task.action = action
        exec("def grasp_actor():\n    action.__init__()", vars(base_task))

        env = Mock(plan_success=True)
        env.check_success.return_value = True
        native_task = ModuleType("envs.adjust_bottle")
        native_task.adjust_bottle = lambda: env
        create_actor = ModuleType("envs.utils.create_actor")
        create_actor.UnStableError = type("UnStableError", (Exception,), {})
        profile = reference()
        profile["environment"]["assets"]["digest"] = "synthetic"
        args = {"domain_randomization": {"cluttered_table": False}, "clear_cache_freq": 5}

        def play_once():
            seed = env.setup_demo.call_args.kwargs["seed"]
            if seed == 100000:
                base_task.grasp_actor()
            if seed == 100002:
                action.__init__()
            if seed == 100003:
                raise RuntimeError("CUDA failed")
            return {"info": {}}

        env.play_once.side_effect = play_once
        with patch.dict(sys.modules, {native_task.__name__: native_task, create_actor.__name__: create_actor}), \
                patch.object(RoboTwinBenchmark, "_native_args", return_value=args):
            plan = plan_robotwin.sample_plan(profile, ["adjust_bottle"], 0, 1, 2)
            self.assertEqual([item["initialStateId"] for item in plan["items"]], ["1"])
            benchmark = RoboTwinBenchmark(profile, "adjust_bottle")
            with self.assertRaisesRegex(AssertionError, "target_pose cannot be None"):
                benchmark.expert_accepts(100002, 0)
            with self.assertRaisesRegex(RuntimeError, "CUDA failed"):
                benchmark.expert_accepts(100003, 0)
        self.assertEqual(env.close_env.call_count, 4)


if __name__ == "__main__":
    unittest.main()
