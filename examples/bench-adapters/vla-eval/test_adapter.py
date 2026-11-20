"""Explicit fixtures; these tests do not start Docker, a benchmark or a model server."""

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
        self.req.update(solve={"output": str(out)}, verify={"output": str(verify)})
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

    def test_scores_the_planned_episode(self):
        r = self.scored(aggregate(True, episode=2))
        self.assertEqual((r["score"], r["invalid"]), (1.0, False))
        self.assertEqual(r["episode"]["endedBy"], "success")
        self.assertEqual(r["review"]["details"]["initial state"], "2")

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
