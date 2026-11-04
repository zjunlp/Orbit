"""Explicit fixtures; these tests do not start Docker, a benchmark or a model server."""

import json
from pathlib import Path
import tempfile
import unittest

import adapter


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "src/vla_eval").mkdir(parents=True)
        self.req = {"benchmark": {"path": str(self.root), "config": {
            "benchmark": "vla_eval.benchmarks.libero.benchmark:LIBEROBenchmark",
            "params": '{"suite": "libero_spatial", "seed": 7}',
            "episodesPerTask": "2",
        }}, "trial": {"task": "libero_spatial:pick up the bowl", "seed": 1, "options": {},
                      "method": {"name": "empty", "agent": "empty"},
                      "staging": str(self.root / "staging")}}
        self.req["trial"]["method"] = {"name": "z", "agent": "empty"}

    def solve(self):
        return adapter.solve(self.req)["spec"]

    def test_a_trial_is_one_task_in_the_benchmark_image(self):
        spec = self.solve()
        self.assertEqual(spec["root"], True)
        self.assertEqual(spec["entrypoint"], adapter.CONDA)
        argv = spec["command"]
        self.assertIn("vla-eval", argv)
        self.assertIn("--no-docker", argv)
        self.assertIn("max_tasks=1", argv)
        # The task is filtered by its own name and the suite stays a fixed condition.
        self.assertIn('tasks=["pick up the bowl"]', argv)
        self.assertEqual(spec["services"][0]["role"], "policy")
        self.assertEqual(spec["services"][0]["gpus"], 0)
        self.assertEqual(spec["resources"]["gpus"], 0)

    def test_the_policy_server_of_empty_is_the_zero_action_policy_in_the_benchmark_image(self):
        svc = self.solve()["services"][0]
        self.assertEqual(svc["image"], "ghcr.io/allenai/vla-evaluation-harness/libero:latest")
        self.assertIn("/orbit-adapter/zero_policy.py", svc["command"])
        self.assertTrue(svc["binds"][0]["source"].endswith("zero_policy.py"))

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
        self.assertEqual(svc["image"], "ghcr.io/example/policy:1")
        self.assertEqual(svc["command"][:2], ["vla-eval", "serve"])
        self.assertEqual(svc["gpus"], 1)

    def test_refuses_cli_agents_and_unknown_config(self):
        self.req["trial"]["method"] = {"name": "c", "agent": "claude-code", "auth": "p"}
        with self.assertRaisesRegex(ValueError, "CLI Agents are not adapted"):
            self.solve()
        self.req["benchmark"]["config"]["nope"] = "1"
        with self.assertRaisesRegex(ValueError, "Unknown vla-eval config: nope"):
            self.solve()

    def test_score_reads_the_aggregate_and_agrees_with_the_verifier(self):
        out = self.root / "solve"
        out.mkdir()
        (out / "LIBEROBenchmark_aggregate.json").write_text(json.dumps({
            "benchmark": "LIBEROBenchmark",
            "tasks": [{"episodes": [
                {"metrics": {"success": 1.0}},
                {"metrics": {"success": 0.0}},
            ]}],
        }))
        verify = self.root / "verify"
        verify.mkdir()
        (verify / "check.json").write_text(json.dumps(adapter.summarize(out)))
        self.req.update(solve={"output": str(out)}, verify={"output": str(verify)})
        r = adapter.score(self.req)
        self.assertEqual((r["score"], r["invalid"]), (0.5, False))
        self.assertEqual(r["metrics"]["success"], 50.0)

    def test_an_upstream_episode_error_is_invalid_not_zero(self):
        out = self.root / "solve2"
        out.mkdir()
        (out / "A_aggregate.json").write_text(json.dumps({
            "benchmark": "A",
            "tasks": [{"episodes": [{"metrics": {"success": 0.0},
                                    "failure_reason": "env_step"}]}],
        }))
        verify = self.root / "verify2"
        verify.mkdir()
        (verify / "check.json").write_text(json.dumps(adapter.summarize(out)))
        self.req.update(solve={"output": str(out)}, verify={"output": str(verify)})
        r = adapter.score(self.req)
        self.assertEqual(r["invalid"], True)
        self.assertEqual(r["failure"], "env_step")

    def test_a_tampered_aggregate_is_invalid(self):
        out = self.root / "solve3"
        out.mkdir()
        (out / "A_aggregate.json").write_text(json.dumps(
            {"tasks": [{"episodes": [{"metrics": {"success": 1.0}}]}]}))
        verify = self.root / "verify3"
        verify.mkdir()
        (verify / "check.json").write_text(json.dumps(
            {"benchmark": "", "episodes": 1, "success": 1.0, "errors": 0, "issues": []}))
        self.req.update(solve={"output": str(out)}, verify={"output": str(verify)})
        self.assertEqual(adapter.score(self.req)["score"], 1.0)
        (verify / "check.json").write_text(json.dumps(
            {"benchmark": "", "episodes": 1, "success": 0.0, "errors": 0, "issues": []}))
        self.assertEqual(adapter.score(self.req)["invalid"], True)


if __name__ == "__main__":
    unittest.main()
