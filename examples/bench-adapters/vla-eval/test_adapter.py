"""Explicit fixtures; these tests do not start Docker, a benchmark or a model server."""

import json
from pathlib import Path
import tempfile
import unittest
import unittest.mock

import adapter


def aggregate(success, episode=0, name="pick up the bowl", error=None, episodes=1):
    ep = {"name": name, "steps": 220, "metrics": {"success": success}}
    if error:
        ep["failure_reason"] = error
    return {"benchmark": "LIBEROBenchmark", "config": {"params": {"orbit_episode": episode}},
            "tasks": [{"episodes": [ep] * episodes}]}


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

    def scored(self, agg, check=None):
        out, verify = self.root / "solve", self.root / "verify"
        out.mkdir(exist_ok=True)
        verify.mkdir(exist_ok=True)
        (out / "LIBEROBenchmark_aggregate.json").write_text(json.dumps(agg))
        (verify / "check.json").write_text(json.dumps(adapter.summarize(out) if check is None else check))
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

    def test_refuses_cli_agents_and_unknown_config(self):
        self.req["trial"]["method"] = {"name": "c", "agent": "claude-code", "auth": "p"}
        with self.assertRaisesRegex(ValueError, "CLI Agents are not adapted"):
            self.solve()
        self.req["benchmark"]["config"]["nope"] = "1"
        with self.assertRaisesRegex(ValueError, "Unknown vla-eval config: nope"):
            self.solve()

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

    def test_a_tampered_result_is_invalid(self):
        other = self.root / "other"
        other.mkdir()
        (other / "A_aggregate.json").write_text(json.dumps(aggregate(True, episode=2)))
        forged = dict(adapter.summarize(other), success=0.0)
        self.assertEqual(self.scored(aggregate(True, episode=2), check=forged)["invalid"], True)

    def test_capabilities_declare_the_embodied_policy_category(self):
        rows = [{"id": "0", "name": "pick up the bowl", "suite": "libero_spatial"}]
        with unittest.mock.patch.object(adapter, "benchmark_in_image", return_value=rows):
            caps = adapter.tasks(self.req)["capabilities"]
        self.assertEqual(caps["category"], "embodied-policy")
        self.assertEqual(caps["calibration"], {"oracle": "none", "seedsVary": True})


if __name__ == "__main__":
    unittest.main()
