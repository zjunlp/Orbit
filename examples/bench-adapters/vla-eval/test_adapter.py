"""Explicit fixtures; these tests do not start Docker, a benchmark or a model server."""

import asyncio
from contextlib import redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import sys
from types import SimpleNamespace
import unittest
import unittest.mock

import adapter


def aggregate(success, episode=0, name="pick up the bowl", error=None, episodes=1):
    ep = {"name": name, "suite": "libero_spatial", "task_id": 2,
          "steps": 220, "metrics": {"success": success}}
    if error:
        ep["failure_reason"] = error
    return {"benchmark": "LIBEROBenchmark", "config": {"params": {"orbit_episode": episode, "suite": "libero_spatial"}},
            "tasks": [{"task": name, "episodes": [ep] * episodes}]}


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "src/vla_eval").mkdir(parents=True)
        self.req = {"benchmark": {"path": str(self.root), "config": {
            "benchmark": "vla_eval.benchmarks.libero.benchmark:LIBEROBenchmark",
            "params": '{"suite": "libero_spatial", "seed": 7}',
        }}, "trial": {"task": "libero_spatial:pick up the bowl", "seed": 3, "options": {},
                      "method": {"name": "z", "agent": "empty"},
                      "staging": str(self.root / "staging")}}

    def solve(self):
        return adapter.solve(self.req)["spec"]

    def legacy_verify_spec(self):
        trial = self.req["trial"]
        return {"command": list(adapter.VERIFY_COMMAND),
                "params": {"task": trial["task"], "method": trial["method"]["name"], "seed": str(trial["seed"])},
                "mounts": [{"target": "/solve", "source": self.req["solve"]["output"], "mode": "ro"}]}

    def scored(self, agg, check=None):
        out, verify = self.root / "solve", self.root / "verify"
        out.mkdir(exist_ok=True)
        verify.mkdir(exist_ok=True)
        (out / "LIBEROBenchmark_aggregate.json").write_text(json.dumps(agg))
        if check is None:
            spec = self.req["benchmark"]["config"]["benchmark"]
            suite, _, task_id = adapter.planned_task(self.req["trial"]["task"], spec)
            check = adapter.summarize(out, suite=suite if spec == adapter.LIBERO_BENCHMARK or task_id is not None else None,
                                      task_id=task_id)
        (verify / "check.json").write_text(json.dumps(check))
        self.req.update(solve={**self.req.get("solve", {}), "output": str(out)}, verify={"output": str(verify)})
        return adapter.score(self.req)

    def test_a_trial_is_one_episode_whose_seed_picks_the_initial_state(self):
        spec = self.solve()
        argv = spec["command"]
        self.assertIn("--no-docker", argv)
        self.assertIn("max_tasks=1", argv)
        self.assertIn("episodes_per_task=1", argv)
        self.assertIn('tasks=["pick up the bowl"]', argv)
        staged = self.root / "staging"
        config = (staged / "vla-eval.yaml").read_text()
        self.assertIn('benchmark: "orbit_episode:OrbitEpisode"', config)
        self.assertIn("orbit_episode: 2", config)  # seed 3 → initial state 2
        module = (staged / "orbit_episode.py").read_text()
        self.assertIn("'vla_eval.benchmarks.libero.benchmark'", module)
        self.assertIn('"episode_idx": self.orbit_episode', module)
        self.assertEqual(spec["env"]["PYTHONPATH"], "/orbit-config")
        self.assertEqual(spec["services"][0]["role"], "policy")
        self.assertEqual(spec["dependsOn"], ["policy"])

    def test_seeds_beyond_the_benchmarks_initial_states_are_refused(self):
        self.req["trial"]["seed"] = 51
        with self.assertRaisesRegex(ValueError, "seed 51 has no episode"):
            self.solve()
        self.req["benchmark"]["config"]["episodesPerTask"] = "2"
        with self.assertRaisesRegex(ValueError, "episodesPerTask is gone"):
            self.solve()

    def test_external_needs_the_model_server_image_and_its_command(self):
        self.req["trial"]["method"] = {"name": "pi05", "agent": "external",
                                      "entrypoint": "ghcr.io/example/policy:1"}
        with self.assertRaisesRegex(ValueError, "config command"):
            self.solve()
        self.req["trial"]["method"]["config"] = {
            "command": '["vla-eval","serve","-c","configs/model_servers/lerobot/pi05_libero.yaml"]',
            "gpus": "1",
        }
        svc = self.solve()["services"][0]
        self.assertEqual((svc["image"], svc["gpus"]), ("ghcr.io/example/policy:1", 1))
        self.req["trial"]["method"]["config"]["serverConfig"] = "/obsolete/path"
        self.assertEqual(self.solve()["services"][0], svc)

    def test_legacy_benchmark_policy_image_is_accepted(self):
        self.req["benchmark"]["config"]["policyImage"] = "fixture:unused"
        rows = [{"id": "0", "name": "pick up the bowl", "suite": "libero_spatial"}]
        with unittest.mock.patch.object(adapter, "benchmark_in_image", return_value=rows):
            self.assertEqual(adapter.tasks(self.req)["tasks"][0]["id"], self.req["trial"]["task"])
        spec = self.solve()
        self.assertEqual(spec["services"][0]["image"], spec["image"])
        self.assertFalse(self.scored(aggregate(True, episode=2))["invalid"])

    def test_fractional_benchmark_timeout_and_trial_override(self):
        self.assertEqual(self.solve()["timeoutMin"], 30)
        config = self.req["benchmark"]["config"]
        config["timeoutMin"] = "1.5"
        self.assertEqual(self.solve()["timeoutMin"], 1.5)
        self.req["trial"]["timeoutMin"] = 2.5
        self.assertEqual(self.solve()["timeoutMin"], 2.5)

    def test_invalid_benchmark_timeouts_are_rejected_before_staging(self):
        with unittest.mock.patch.object(adapter, "benchmark_in_image") as discovery:
            for value in ("0", "-1", "nan", "inf", "unknown"):
                with self.subTest(timeout=value):
                    self.req["benchmark"]["config"]["timeoutMin"] = value
                    with self.assertRaisesRegex(ValueError, "timeoutMin must be a finite positive number"):
                        adapter.tasks(self.req)
                    with self.assertRaisesRegex(ValueError, "timeoutMin must be a finite positive number"):
                        self.solve()
            discovery.assert_not_called()
        self.assertFalse((self.root / "staging").exists())

    def test_refuses_cli_agents_and_unknown_config(self):
        self.req["trial"]["method"] = {"name": "c", "agent": "claude-code", "auth": "p"}
        with self.assertRaisesRegex(ValueError, "CLI Agents are not adapted"):
            self.solve()
        self.req["benchmark"]["config"]["nope"] = "1"
        with self.assertRaisesRegex(ValueError, "Unknown vla-eval config: nope"):
            self.solve()

    def test_custom_benchmark_can_enumerate_tasks_during_construction(self):
        class Native:
            def __init__(self, orbit_task_id):
                self.index = orbit_task_id
                self.summary = self.get_tasks()

            def get_tasks(self):
                return [{"name": "custom task", "task_id": self.index}]

        self.req["benchmark"]["config"].update(
            benchmark="custom:Native", params='{"orbit_task_id": 3}')
        self.req["trial"]["task"] = "task:custom task"
        self.solve()
        module = self.root / "staging" / "orbit_episode.py"
        namespace = {}
        with unittest.mock.patch.dict(sys.modules, {"custom": SimpleNamespace(Native=Native)}):
            exec(module.read_text(), namespace)
        wrapper = namespace["OrbitEpisode"]
        self.assertIs(wrapper.get_tasks, Native.get_tasks)
        self.assertEqual(wrapper(orbit_episode=2, orbit_task_id=3).summary,
                         [{"name": "custom task", "task_id": 3}])

    def test_task_discovery_uses_the_inspected_image_and_ignores_old_cache_entries(self):
        spec = "custom:Native"
        image_id = "sha256:" + "a" * 64
        cache = self.root / f"orbit-vla-eval-tasks-{os.getuid()}"
        cache.mkdir(mode=0o700)
        old_key = hashlib.sha256(json.dumps([image_id, spec, {}], sort_keys=True).encode()).hexdigest()
        (cache / (old_key + ".json")).write_text('[{"name": "stale catalog"}]')
        rows = [{"name": "catalog from the inspected image"}]
        response = SimpleNamespace(returncode=0, stdout=json.dumps(rows), stderr="")
        with unittest.mock.patch.object(adapter.tempfile, "gettempdir", return_value=str(self.root)), \
                unittest.mock.patch.object(adapter.subprocess, "check_output", return_value=image_id), \
                unittest.mock.patch.object(adapter.subprocess, "run", return_value=response) as run:
            self.assertEqual(adapter.benchmark_in_image("fixture:moving", spec, {}), rows)
            command = run.call_args.args[0]
            self.assertEqual(command[command.index("--entrypoint") + 2], image_id)
            self.assertEqual(adapter.benchmark_in_image(image_id, spec, {}), rows)
            self.assertEqual(run.call_count, 1)
            identified = [{"name": "catalog with native identity", "identity": {"seed": 17}}]
            run.return_value = SimpleNamespace(returncode=0, stdout=json.dumps(identified), stderr="")
            self.assertEqual(adapter.benchmark_in_image(image_id, spec, {}, ("seed",)), identified)
            self.assertEqual(json.loads(run.call_args.args[0][-1]), ["seed"])
            self.assertEqual(adapter.benchmark_in_image(image_id, spec, {}, ("seed",)), identified)
            self.assertEqual(run.call_count, 2)

    def test_official_image_environment_is_used_for_discovery_solve_and_empty_policy(self):
        config = self.req["benchmark"]["config"]
        for spec, env in (
            ("vla_eval.benchmarks.libero_mem.benchmark:LIBEROMemBenchmark", "libero_mem"),
            ("vla_eval.benchmarks.robotwin.benchmark:RoboTwinBenchmark", "robotwin"),
            ("custom:Native", "libero"),
        ):
            with self.subTest(spec=spec):
                config["benchmark"] = spec
                robotwin = spec == adapter.ROBOTWIN_BENCHMARK
                self.req["trial"].update(task="robotwin:adjust_bottle" if robotwin else
                                         "libero_spatial:pick up the bowl", seed=1)
                rows = [{"id": "0", "name": "adjust_bottle", "suite": "robotwin", "identity": {"seed": 100002}}]
                with unittest.mock.patch.object(adapter, "benchmark_in_image", return_value=rows):
                    solve = self.solve()
                self.assertEqual(solve["command"][3], env)
                self.assertEqual(solve["services"][0]["command"][3], env)
                with unittest.mock.patch.object(adapter.tempfile, "gettempdir", return_value=str(self.root)), \
                        unittest.mock.patch.object(adapter.subprocess, "check_output", return_value="fixture-id"), \
                        unittest.mock.patch.object(adapter.subprocess, "run",
                                                   return_value=SimpleNamespace(returncode=0, stdout="[]", stderr="")) as run:
                    self.assertEqual(adapter.benchmark_in_image("fixture", spec, {}), [])
                    argv = run.call_args.args[0]
                    self.assertEqual(argv[argv.index("-lc") + 2], env)

    def test_robotwin_selects_and_verifies_same_name_scenes_by_native_seed(self):
        spec = adapter.ROBOTWIN_BENCHMARK
        self.req["benchmark"]["config"].update(benchmark=spec, params='{"seed": 0}')
        module = spec.split(":")[0]
        scenes = [{"suite": "robotwin", "name": "adjust_bottle", "seed": seed, "episode_idx": index}
                  for index, seed in enumerate((100001, 100002))]

        class Native:
            def __init__(self, seed, task_config):
                self.task_config = task_config

            def get_tasks(self):
                return list(reversed(scenes))

            async def start_episode(self, task, recorder=None):
                return task

        stdout = io.StringIO()
        with unittest.mock.patch.dict(sys.modules, {module: SimpleNamespace(RoboTwinBenchmark=Native)}), \
                unittest.mock.patch.object(sys, "argv", ["discovery", module, "RoboTwinBenchmark",
                                                         '{"seed": 0, "task_config": "demo_clean"}', '["seed"]']), \
                redirect_stdout(stdout):
            exec(adapter.TASKS_SCRIPT, {})
        rows = json.loads(stdout.getvalue())
        self.req["trial"].update(task="robotwin:adjust_bottle", seed=1)
        with unittest.mock.patch.object(adapter, "benchmark_in_image", return_value=rows) as discover:
            listing = adapter.tasks(self.req)
            first = self.solve()
            self.req["trial"]["seed"] = 2
            solve = self.solve()
            for call in discover.call_args_list:
                self.assertEqual(call.args[2]["task_config"], "demo_clean")
        [task] = listing["tasks"]
        self.assertEqual(task["id"], "robotwin:adjust_bottle")
        self.assertEqual(task["initialStates"], {"count": 2})
        self.assertTrue(listing["capabilities"]["calibration"]["seedsVary"])
        self.assertEqual(json.loads(first["env"][adapter.ROBOTWIN_SCENE_ENV])["taskIdentity"]["seed"], 100001)
        self.req["solve"] = {"run": {"spec": solve}}
        self.assertIn('tasks=["adjust_bottle"]', solve["command"])
        staging = self.root / "staging"
        self.assertTrue((staging / "task_identity.py").is_file())
        yaml = (staging / "vla-eval.yaml").read_text()
        identity = json.loads(next(line.split(":", 1)[1] for line in yaml.splitlines()
                                   if line.strip().startswith("orbit_task_identity:")))
        namespace = {}
        with unittest.mock.patch.dict(sys.modules, {module: SimpleNamespace(RoboTwinBenchmark=Native)}):
            exec((staging / "orbit_episode.py").read_text(), namespace)
        wrapper = namespace["OrbitEpisode"](orbit_task_identity=identity, orbit_episode=1, seed=0,
                                            task_config="demo_clean")
        for ordered in (scenes, list(reversed(scenes))):
            with unittest.mock.patch.object(Native, "get_tasks", return_value=ordered):
                [selected] = wrapper.get_tasks()
            self.assertEqual(asyncio.run(wrapper.start_episode(selected)), scenes[1])
        for ambiguous in ([scenes[0]], [scenes[1], scenes[1]]):
            with unittest.mock.patch.object(Native, "get_tasks", return_value=ambiguous):
                with self.assertRaisesRegex(ValueError, "missing or ambiguous"):
                    wrapper.get_tasks()

        result = aggregate(True, episode=1, name="adjust_bottle")
        params = result["config"]["params"]
        params.update(seed=0, task_config="demo_clean", orbit_task_identity=identity)
        ep = result["tasks"][0]["episodes"][0]
        ep.update(scenes[1])
        self.scored(result, check={})
        verify = adapter.verify(self.req)["spec"]
        self.req["verify"]["run"] = {"spec": verify}
        self.assertIn("/orbit-adapter/task_identity.py", [m["target"] for m in verify["mounts"]])
        output = Path(self.req["verify"]["output"])
        command = [sys.executable, "-B", str(adapter.HERE / "check.py"),
                   self.req["solve"]["output"], *verify["command"][2:]]
        check_env = {**os.environ, "ORBIT_OUTPUT": str(output)}
        subprocess.run(command, env=check_env, check=True)
        receipt = json.loads((output / "check.json").read_text())
        self.assertEqual(receipt["taskIdentity"]["seed"], 100002)
        score = adapter.score(self.req)
        self.assertFalse(score["invalid"])
        self.assertEqual(score["review"]["details"]["initial state"], "100002")
        self.assertEqual(score["review"]["details"]["trial number"], "2")

        for target, key, value, message in (
            (result, "harness_version", "another snapshot", "Verifier output disagrees"),
            (ep, "seed", 100001, "scene identity"),
            (params, "task_config", "demo_randomized", "scene config"),
            (params, "orbit_episode", 0, "trial number"),
        ):
            with self.subTest(key=key), unittest.mock.patch.dict(target, {key: value}):
                self.assertIn(message, self.scored(result, check=receipt)["issues"][0])
                if key != "harness_version":
                    rejected = subprocess.run(command, env=check_env, capture_output=True, text=True, check=False)
                    self.assertEqual(rejected.returncode, 1)
                    self.assertIn(message, rejected.stderr)

    def test_robotwin_can_run_a_single_explicit_scene(self):
        self.req["benchmark"]["config"].update(benchmark=adapter.ROBOTWIN_BENCHMARK, params="{}")
        self.req["trial"].update(task="robotwin:adjust_bottle", seed=1, options={"sceneSeeds": "[100002]"})
        rows = [{"id": str(index), "name": "adjust_bottle", "suite": "robotwin", "identity": {"seed": seed}}
                for index, seed in enumerate((100001, 100002))]
        with unittest.mock.patch.object(adapter, "benchmark_in_image", return_value=rows):
            scene = json.loads(self.solve()["env"][adapter.ROBOTWIN_SCENE_ENV])
            self.assertEqual((scene["episode"], scene["taskIdentity"]["seed"]), (0, 100002))
            for seeds in ("[100000]", "[100002,100002]", '["100002"]'):
                with self.subTest(seeds=seeds), self.assertRaisesRegex(ValueError, "sceneSeeds"):
                    self.req["trial"]["options"]["sceneSeeds"] = seeds
                    self.solve()
            self.req["trial"].update(seed=3, options={})
            with self.assertRaisesRegex(ValueError, "trial 3 has no RoboTwin scene"):
                self.solve()

    def test_configured_identity_uses_multiple_fields_for_custom_benchmarks(self):
        self.req["benchmark"]["config"].update(
            benchmark="custom:Native", params="{}", taskIdentityFields='["kind", "case_name"]')
        native = [{"name": "move: block", "kind": kind, "case_name": "case,1"}
                  for kind in ("base", "扰动")]
        rows = [{"id": str(index), "suite": "", "name": item["name"],
                 "identity": {field: item[field] for field in ("kind", "case_name")}}
                for index, item in enumerate(native)]
        with unittest.mock.patch.object(adapter, "benchmark_in_image", return_value=rows):
            tasks = adapter.tasks(self.req)["tasks"]
        self.assertEqual(len({task["id"] for task in tasks}), 2)
        self.req["trial"]["task"] = tasks[1]["id"]
        self.solve()
        yaml = (self.root / "staging" / "vla-eval.yaml").read_text()
        expected = json.loads(next(line.split(":", 1)[1] for line in yaml.splitlines()
                                   if line.strip().startswith("orbit_task_identity:")))
        self.assertEqual(expected, {**native[1], "suite": "task"})

        class Native:
            def __init__(self):
                self.selected = self.get_tasks()

            def get_tasks(self):
                return native

        namespace = {}
        with unittest.mock.patch.dict(sys.modules, {"custom": SimpleNamespace(Native=Native)}):
            exec((self.root / "staging/orbit_episode.py").read_text(), namespace)
        instance = namespace["OrbitEpisode"](orbit_task_identity=expected)
        self.assertEqual(instance.selected, [native[1]])

        result = aggregate(0.5, episode=2, name=native[1]["name"])
        ep = result["tasks"][0]["episodes"][0]
        ep.pop("suite")
        ep.update(native[1])
        self.scored(result, check={})
        verify = adapter.verify(self.req)["spec"]
        subprocess.run([sys.executable, "-B", str(adapter.HERE / "check.py"),
                        self.req["solve"]["output"], *verify["command"][2:]],
                       env={**os.environ, "ORBIT_OUTPUT": self.req["verify"]["output"]}, check=True)
        self.req["verify"]["run"] = {"spec": verify}
        self.assertEqual(adapter.score(self.req)["score"], 0.5)
        ep.update(native[0])
        self.assertIn("scene identity", self.scored(result, check={})["issues"][0])

    def test_missing_or_duplicate_scene_identity_is_rejected_at_discovery(self):
        self.req["benchmark"]["config"]["benchmark"] = adapter.ROBOTWIN_BENCHMARK
        incomplete = {"id": "0", "suite": "robotwin", "name": "adjust_bottle", "identity": {}}
        complete = {**incomplete, "identity": {"seed": 100002}}
        for rows, message in (([incomplete], "lacks a stable value"), ([complete, complete], "duplicate RoboTwin scene")):
            with unittest.mock.patch.object(adapter, "benchmark_in_image", return_value=rows):
                with self.assertRaisesRegex(ValueError, message):
                    adapter.tasks(self.req)

    def test_same_name_libero_tasks_keep_distinct_native_ids(self):
        config = self.req["benchmark"]["config"]
        config["params"] = '{"suite": "libero_90"}'
        rows = [{"id": str(index), "name": "open drawer", "suite": "libero_90"} for index in (7, 11)]
        with unittest.mock.patch.object(adapter, "benchmark_in_image", return_value=rows):
            listed = adapter.tasks(self.req)["tasks"]
        self.assertEqual([task["id"] for task in listed],
                         ["libero_90:@7:open drawer", "libero_90:@11:open drawer"])
        self.req["trial"]["task"] = listed[1]["id"]
        self.solve()
        staging = self.root / "staging"
        self.assertIn('orbit_task_id: 11', (staging / "vla-eval.yaml").read_text())

        class Native:
            def get_tasks(self):
                return [{"name": "open drawer", "task_id": index} for index in (7, 11)]

        namespace = {}
        with unittest.mock.patch.dict(sys.modules, {"vla_eval.benchmarks.libero.benchmark":
                                                   SimpleNamespace(LIBEROBenchmark=Native)}):
            exec((staging / "orbit_episode.py").read_text(), namespace)
        wrapper = namespace["OrbitEpisode"]
        self.assertEqual(wrapper(orbit_task_name="open drawer", orbit_task_id=11).get_tasks(),
                         [{"name": "open drawer", "task_id": 11}])
        with self.assertRaisesRegex(ValueError, "missing or ambiguous"):
            wrapper(orbit_task_name="open drawer").get_tasks()

        agg = aggregate(True, episode=2, name="open drawer")
        agg["config"]["params"].update(suite="libero_90", orbit_task_id=11)
        row = agg["tasks"][0]["episodes"][0]
        row.update(suite="libero_90", task_id=11)
        self.assertFalse(self.scored(agg)["invalid"])
        row["task_id"] = 7
        self.assertEqual(self.scored(agg, check={})["failure"], "scorer_error")

    def test_same_name_libero_tasks_cannot_swap_verify_receipts(self):
        name = "open drawer"
        cases = (
            (("libero_90", 7), ("libero_90", 11), True),
            (("libero_10", 5), ("libero_90", 77), False),
        )
        for first, second, indexed in cases:
            for suite, native_id in (first, second):
                with self.subTest(suite=suite, native_id=native_id, indexed=indexed):
                    task = f"@{native_id}:{name}" if indexed else name
                    self.req["trial"]["task"] = f"{suite}:{task}"
                    out = self.root / f"solve-{native_id}"
                    out.mkdir()
                    self.req["solve"] = {"output": str(out)}
                    agg = aggregate(True, episode=2, name=name)
                    agg["config"]["params"].update(suite=suite, orbit_task_id=native_id if indexed else None)
                    agg["tasks"][0]["episodes"][0].update(suite=suite, task_id=native_id)
                    (out / "LIBEROBenchmark_aggregate.json").write_text(json.dumps(agg))
                    command = adapter.verify(self.req)["spec"]["command"]
                    check_dir = self.root / f"check-{native_id}"
                    subprocess.run([sys.executable, "-B", str(adapter.HERE / "check.py"),
                                    str(out), *command[2:]],
                                   env={**os.environ, "ORBIT_OUTPUT": str(check_dir)}, check=True)
                    self.req["verify"] = {"output": str(check_dir), "run": {"spec": {"command": command}}}
                    self.assertFalse(adapter.score(self.req)["invalid"])
            self.req["verify"]["output"] = str(self.root / f"check-{first[1]}")
            self.assertIn("Verifier output disagrees", adapter.score(self.req)["issues"][0])

    def test_libero_plus_indexes_only_duplicate_names_and_checks_the_native_result(self):
        self.req["benchmark"]["config"]["benchmark"] = adapter.LIBERO_PLUS_BENCHMARK
        suite = "libero_spatial"
        rows = [{"id": str(task_id), "name": name, "suite": suite}
                for task_id, name in ((7, "open drawer"), (11, "open drawer"), (15, "close drawer"))]
        with unittest.mock.patch.object(adapter, "benchmark_in_image", return_value=rows):
            listed = adapter.tasks(self.req)["tasks"]
        self.assertEqual([task["id"] for task in listed],
                         [f"{suite}:@7:open drawer", f"{suite}:@11:open drawer", f"{suite}:close drawer"])
        staging = self.root / "staging"
        self.req["trial"]["task"] = listed[2]["id"]
        self.solve()
        self.assertNotIn("orbit_task_id", (staging / "vla-eval.yaml").read_text())
        self.assertFalse(self.scored(aggregate(True, episode=2, name="close drawer"))["invalid"])

        self.req["trial"]["task"] = listed[1]["id"]
        self.solve()
        self.assertIn("orbit_task_id: 11", (staging / "vla-eval.yaml").read_text())
        self.assertEqual(adapter.verify(self.req)["spec"]["command"][2:], [suite, "11"])
        result = aggregate(True, episode=2, name="open drawer")
        result["config"]["params"]["orbit_task_id"] = 11
        episode = result["tasks"][0]["episodes"][0]
        episode["task_id"] = 11
        self.assertFalse(self.scored(result)["invalid"])
        episode["task_id"] = 7
        self.assertIn("differs from the planned LIBERO task", self.scored(result, check={})["issues"][0])

    def test_unique_libero_plus_score_checks_suite_without_changing_generic_receipts(self):
        self.req["benchmark"]["config"]["benchmark"] = adapter.LIBERO_PLUS_BENCHMARK
        result = aggregate(True, episode=2)
        self.assertFalse(self.scored(result)["invalid"])
        receipt = json.loads((Path(self.req["verify"]["output"]) / "check.json").read_text())
        self.assertNotIn("aggregateDigest", receipt)
        wrong = "libero_90"
        result["config"]["params"]["suite"] = wrong
        result["tasks"][0]["episodes"][0]["suite"] = wrong
        self.assertEqual(self.scored(result, check=receipt)["failure"], "scorer_error")

    def test_legacy_libero_receipt_requires_a_legacy_verify_run(self):
        agg = aggregate(True, episode=2)
        self.assertFalse(self.scored(agg)["invalid"])
        out = Path(self.req["solve"]["output"])
        verdict = Path(self.req["verify"]["output"]) / "check.json"
        verdict.write_text(json.dumps(adapter.summarize(out)))
        self.req["verify"]["run"] = {"spec": {"command": adapter.verify(self.req)["spec"]["command"]}}
        self.assertTrue(adapter.score(self.req)["invalid"])
        self.req["verify"]["run"]["spec"] = self.legacy_verify_spec()
        self.req["verify"]["run"]["spec"]["params"]["task"] = "libero_90:pick up the bowl"
        self.assertTrue(adapter.score(self.req)["invalid"])
        self.req["verify"]["run"]["spec"]["params"]["task"] = self.req["trial"]["task"]
        self.assertFalse(adapter.score(self.req)["invalid"])

    def test_libero_pro_choices_use_the_native_id_and_resolved_suite(self):
        spec = adapter.LIBERO_PRO_BENCHMARK
        config = self.req["benchmark"]["config"]
        config["benchmark"] = spec
        name = "open drawer"
        for params, suite in (({"suite": "libero_90"}, "libero_90"),
                              ({"suite": "libero_spatial", "perturbation": "position"}, "libero_spatial_swap"),
                              ({}, "libero_spatial_with_mug")):
            with self.subTest(suite=suite):
                config["params"] = json.dumps(params)
                rows = [{"id": str(i), "name": name, "suite": suite} for i in (0, 1)]
                with unittest.mock.patch.object(adapter, "benchmark_in_image", return_value=rows):
                    listed = adapter.tasks(self.req)["tasks"]
                self.assertEqual([row["id"] for row in listed], [f"{suite}:@0:{name}", f"{suite}:@1:{name}"])
                self.req["trial"]["task"] = listed[1]["id"]
                self.solve()
                staged = self.root / "staging"
                yaml = (staged / "vla-eval.yaml").read_text()
                self.assertIn(f'orbit_task_suite: "{suite}"', yaml)

                class Native:
                    def __init__(self, **kw):
                        pass

                    def get_tasks(self):
                        return [{"name": name, "task_id": i, "suite": task_suite}
                                for i, task_suite in ((0, suite), (1, suite), (1, "wrong_suite"))]

                namespace = {}
                with unittest.mock.patch.dict(sys.modules, {spec.split(":")[0]: SimpleNamespace(LIBEROProBenchmark=Native)}):
                    exec((staged / "orbit_episode.py").read_text(), namespace)
                instance = namespace["OrbitEpisode"](orbit_task_name=name, orbit_task_id=1, orbit_task_suite=suite, **params)
                self.assertEqual(instance.get_tasks(), [{"name": name, "task_id": 1, "suite": suite}])
                agg = aggregate(True, episode=2, name=name)
                agg["config"]["params"] = {**params, "orbit_episode": 2, "orbit_task_id": 1, "orbit_task_suite": suite}
                ep = agg["tasks"][0]["episodes"][0]
                ep.update(suite=suite, task_id=1)
                self.scored(agg, check={})
                env = {**os.environ, "ORBIT_OUTPUT": self.req["verify"]["output"]}
                command = adapter.verify(self.req)["spec"]["command"]
                subprocess.run([sys.executable, "-B", str(adapter.HERE / "check.py"),
                                self.req["solve"]["output"], *command[2:]], env=env, check=True)
                self.assertFalse(adapter.score(self.req)["invalid"])
                ep["suite"] = "wrong_suite"
                self.assertEqual(self.scored(agg, check={})["failure"], "scorer_error")

    def test_legacy_failure_receipt_keeps_the_upstream_failure_kind(self):
        for benchmark in (adapter.LIBERO_BENCHMARK, "custom:Native"):
            with self.subTest(benchmark=benchmark):
                self.req["benchmark"]["config"]["benchmark"] = benchmark
                self.assertEqual(self.scored(aggregate(False, episode=2, error="model_act"))["failure"],
                                 "policy_act")
                out = Path(self.req["solve"]["output"])
                verdict = Path(self.req["verify"]["output"]) / "check.json"
                legacy = adapter.summarize(out)
                del legacy["failureReason"]
                verdict.write_text(json.dumps(legacy))
                run = self.legacy_verify_spec()
                self.req["verify"]["run"] = {"spec": run}
                self.assertEqual(adapter.score(self.req)["failure"], "policy_act")
                for params, key, wrong in ((run["params"], "task", "wrong-task"),
                                           (run["params"], "method", "another-policy"),
                                           (run["params"], "seed", "4"),
                                           (run["mounts"][0], "source", str(self.root / "other-solve")),
                                           (run["mounts"][0], "mode", "rw")):
                    with self.subTest(key=key):
                        saved, params[key] = params[key], wrong
                        self.assertEqual(adapter.score(self.req)["failure"], "scorer_error")
                        params[key] = saved
                legacy["issues"] = []
                verdict.write_text(json.dumps(legacy))
                self.assertEqual(adapter.score(self.req)["failure"], "scorer_error")
                if benchmark == adapter.LIBERO_BENCHMARK:
                    modern = adapter.summarize(out, suite="libero_spatial")
                    del modern["failureReason"]
                    verdict.write_text(json.dumps(modern))
                    run["command"] = adapter.verify(self.req)["spec"]["command"]
                    self.assertEqual(adapter.score(self.req)["failure"], "scorer_error")

    def test_new_custom_verify_cannot_use_the_legacy_failure_projection(self):
        self.req["benchmark"]["config"]["benchmark"] = "custom:Native"
        self.scored(aggregate(False, episode=2, error="model_act"))
        command = adapter.verify(self.req)["spec"]["command"]
        verification = Path(self.req["verify"]["output"])
        subprocess.run([sys.executable, "-B", str(adapter.HERE / "check.py"),
                        self.req["solve"]["output"], *command[2:]],
                       env={**os.environ, "ORBIT_OUTPUT": str(verification)}, check=True)
        self.req["verify"]["run"] = {"spec": {**self.legacy_verify_spec(), "command": command}}
        self.assertEqual(adapter.score(self.req)["failure"], "policy_act")
        check = verification / "check.json"
        damaged = json.loads(check.read_text())
        del damaged["failureReason"]
        check.write_text(json.dumps(damaged))
        self.assertEqual(adapter.score(self.req)["failure"], "scorer_error")

    def test_rejects_mismatched_libero_names_and_suites(self):
        agg = aggregate(True, episode=2, name="another task")
        agg["tasks"][0]["task"] = "pick up the bowl"
        self.assertIn("differs from the episode", self.scored(agg, check={})["issues"][0])
        agg["tasks"][0]["episodes"][0].update(name="pick up the bowl", suite="libero_90")
        self.assertIn("differs from the planned LIBERO task", self.scored(agg, check={})["issues"][0])
        agg["config"]["params"].pop("suite")  # Omitted when an older launch used the native default.
        row = agg["tasks"][0]["episodes"][0]
        row["suite"] = "libero_spatial"
        self.assertFalse(self.scored(agg)["invalid"])
        row["failure_reason"] = "model_act"
        for field in ("name", "suite", "task_id"):
            with self.subTest(field=field):
                value = row.pop(field)
                self.assertEqual(self.scored(agg, check={})["failure"], "scorer_error")
                row[field] = value

    def test_generic_checker_and_score_require_the_episode_task_name(self):
        for spec in ("custom:Native", adapter.LIBERO_PLUS_BENCHMARK):
            self.req["benchmark"]["config"]["benchmark"] = spec
            agg = aggregate(True, episode=2)
            self.assertFalse(self.scored(agg)["invalid"])
            receipt = json.loads((Path(self.req["verify"]["output"]) / "check.json").read_text())
            command = adapter.verify(self.req)["spec"]["command"]
            for other_name in ("another task", None):
                with self.subTest(spec=spec, other_name=other_name):
                    agg["tasks"][0]["episodes"][0]["name"] = other_name
                    self.assertEqual(self.scored(agg, check=receipt)["failure"], "scorer_error")
                    run = subprocess.run(
                        [sys.executable, "-B", str(adapter.HERE / "check.py"),
                         self.req["solve"]["output"], *command[2:]],
                        env={**os.environ, "ORBIT_OUTPUT": str(self.root / "recheck")},
                        capture_output=True, text=True, check=False,
                    )
                    self.assertEqual(run.returncode, 1)
                    self.assertIn("episode", run.stderr)

    def test_scores_the_planned_episode(self):
        r = self.scored(aggregate(True, episode=2))
        self.assertEqual((r["score"], r["invalid"]), (1.0, False))
        self.assertEqual(r["episode"]["endedBy"], "success")
        self.assertEqual(r["review"]["details"]["initial state"], "2")

    def test_custom_scalar_score_survives_verify_and_legacy_receipts(self):
        self.req["benchmark"]["config"]["benchmark"] = "custom:Native"
        agg = aggregate(0.5, episode=2)
        agg["benchmark"] = "Native"
        self.scored(agg, check={})
        legacy = {"benchmark": "Native", "task": "pick up the bowl", "episode": 2,
                  "steps": 220, "success": 0.5, "errors": 0, "issues": []}
        out = Path(self.req["solve"]["output"])
        verify = Path(self.req["verify"]["output"])
        (verify / "check.json").write_text(json.dumps(legacy))
        self.req["verify"]["run"] = {"spec": self.legacy_verify_spec()}
        self.assertEqual(adapter.score(self.req)["score"], 0.5)

        spec = adapter.verify(self.req)["spec"]
        subprocess.run([sys.executable, "-B", str(adapter.HERE / "check.py"),
                        str(out), *spec["command"][2:]],
                       env={**os.environ, "ORBIT_OUTPUT": str(verify)}, check=True)
        self.req["verify"]["run"] = {"spec": spec}
        result = adapter.score(self.req)
        self.assertEqual((result["invalid"], result["score"], result["metrics"]["success"]),
                         (False, 0.5, 50.0))

    def test_libero_routes_require_a_binary_success_metric(self):
        for benchmark in adapter.INDEXED_LIBERO_BENCHMARKS:
            with self.subTest(benchmark=benchmark):
                self.req["benchmark"]["config"]["benchmark"] = benchmark
                result = self.scored(aggregate(0.5, episode=2), check={})
                self.assertIn("binary", result["issues"][0])
                command = adapter.verify(self.req)["spec"]["command"]
                run = subprocess.run(
                    [sys.executable, "-B", str(adapter.HERE / "check.py"),
                     self.req["solve"]["output"], *command[2:]],
                    capture_output=True, text=True, check=False,
                )
                self.assertEqual(run.returncode, 1)
                self.assertIn("binary", run.stderr)

    def test_another_episode_or_several_are_invalid(self):
        self.assertEqual(self.scored(aggregate(True, episode=0))["failure"], "scorer_error")
        self.assertIn("one episode", self.scored(aggregate(True, episode=2, episodes=2),
                                                 check={})["issues"][0])

    def test_an_upstream_episode_error_is_invalid_not_zero(self):
        r = self.scored(aggregate(False, episode=2, error="env_step"))
        self.assertEqual((r["invalid"], r["failure"]), (True, "env_step"))

    def test_binary_score_and_native_failure_classes(self):
        self.assertIn("binary", self.scored(aggregate(4.2, episode=2), check={})["issues"][0])
        result = self.scored(aggregate(False, episode=2, error="model_start"))
        self.assertEqual(result["failure"], "policy_start")
        result = self.scored(aggregate(False, episode=2, error="model_act"))
        self.assertEqual(result["failure"], "policy_act")
        result = self.scored(aggregate(False, episode=2, error="timeout"))
        self.assertEqual(result["failure"], "call_watchdog")

    def test_a_tampered_result_is_invalid(self):
        other = self.root / "other"
        other.mkdir()
        (other / "A_aggregate.json").write_text(json.dumps(aggregate(True, episode=2)))
        forged = dict(adapter.summarize(other), success=0.0)
        self.assertEqual(self.scored(aggregate(True, episode=2), check=forged)["invalid"], True)

    def test_capabilities_declare_embodied_policy_calibration(self):
        rows = [{"id": "0", "name": "pick up the bowl", "suite": "libero_spatial"}]
        with unittest.mock.patch.object(adapter, "benchmark_in_image", return_value=rows):
            caps = adapter.tasks(self.req)["capabilities"]
        self.assertNotIn("category", caps)
        self.assertEqual(caps["taxonomy"], {"domains": ["robotics"]})
        self.assertEqual(caps["identity"]["id"], "libero")
        self.assertEqual(caps["calibration"], {"empty": "any", "oracle": "none", "seedsVary": True})

    def test_configured_benchmarks_do_not_share_libero_identity(self):
        config = self.req["benchmark"]["config"]
        with unittest.mock.patch.object(adapter, "benchmark_in_image", return_value=[]):
            config["benchmark"] = "fixture.benchmarks:OtherBenchmark"
            first = adapter.tasks(self.req)["capabilities"]["identity"]
            config["params"] = '{"seed": 99}'
            self.assertEqual(adapter.tasks(self.req)["capabilities"]["identity"], first)
            config["benchmark"] = "fixture.benchmarks:AnotherBenchmark"
            second = adapter.tasks(self.req)["capabilities"]["identity"]
        self.assertNotEqual(first["id"], "libero")
        self.assertNotEqual(second["id"], first["id"])
        self.assertEqual(first["name"], "fixture.benchmarks:OtherBenchmark")


if __name__ == "__main__":
    unittest.main()
