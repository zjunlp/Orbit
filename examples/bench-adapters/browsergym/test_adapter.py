"""Explicit filesystem fixtures; these tests do not execute BrowserGym or Chromium."""

import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import adapter
import evidence


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        html = self.root / "miniwob/html/miniwob"
        html.mkdir(parents=True)
        for name in ("click-test", "unsupported-fixture"):
            (html / f"{name}.html").write_text("explicit task fixture")
        self.req = {"benchmark": {"path": str(self.root), "config": {}},
                    "trial": {"task": "miniwob.click-test", "seed": 1, "options": {},
                              "method": {"name": "policy", "agent": "external",
                                         "entrypoint": "policy:make_agent"},
                              "staging": str(self.root / "staging")}}

    def plan(self):
        with patch.object(adapter, "checkout_revision", return_value=evidence.MINIWOB_COMMIT):
            spec = adapter.solve(self.req)["spec"]
        return spec, evidence.read(self.root / "staging/plan.json")

    def episode(self, reward=1):
        _, plan = self.plan()
        out = self.root / "solve"
        out.mkdir()
        (out / "screenshots").mkdir()
        evidence.write(out / "plan.json", plan)
        rows = [{"step": i, "screenshot": f"screenshots/{i:04d}.png",
                 "action": None if i == 0 else "click('1')", "reward": reward if i else 0,
                 "terminated": i == 1, "truncated": False,
                 "task_info": {"RAW_REWARD_GLOBAL": reward if i else 0}} for i in range(2)]
        for row in rows:
            (out / row["screenshot"]).write_bytes(b"explicit screenshot fixture")
        self.rows = rows
        self.out = out
        self.result = {"status": "completed", "steps": 1, "reward": reward,
                       "stop_reason": "terminated"}
        self.save()
        verify = self.root / "verify"
        verify.mkdir()
        evidence.write(verify / "validation.json", evidence.validate(out))
        self.req.update(solve={"output": str(out)}, verify={"output": str(verify)})
        return out

    def save(self):
        (self.out / "trajectory.jsonl").write_text("\n".join(json.dumps(r) for r in self.rows))
        paths = [self.out / "plan.json", self.out / "trajectory.jsonl",
                 *sorted((self.out / "screenshots").glob("*.png"))]
        self.result["sha256"] = {str(p.relative_to(self.out)): evidence.digest(p) for p in paths}
        evidence.write(self.out / "result.json", self.result)

    def test_catalog_lists_missing_and_unsupported_tasks(self):
        rows = {r["id"]: r for r in adapter.tasks(self.req)["tasks"]}
        self.assertTrue(rows["miniwob.click-test"]["supported"])
        self.assertFalse(rows["miniwob.enter-text"]["supported"])
        self.assertFalse(rows["miniwob.unsupported-fixture"]["supported"])

    def test_catalog_is_the_full_pinned_registration(self):
        self.assertEqual(len(adapter.TASKS), 125)
        rows = {r["id"]: r for r in adapter.tasks(self.req)["tasks"]}
        # Registered but without original HTML here: listed, not runnable.
        self.assertEqual(rows["miniwob.enter-text"]["reason"], "Missing original task HTML")
        self.assertIn("Not registered", rows["miniwob.unsupported-fixture"]["reason"])
        self.assertIn("125 tasks", adapter.tasks(self.req)["capabilities"]["conditions"]["Coverage"])

    def test_backend_suites_are_refused_not_run_under_changed_conditions(self):
        for suite in ("webarena", "visualwebarena", "workarena"):
            self.req["benchmark"]["config"]["suite"] = suite
            with self.assertRaisesRegex(ValueError, "exclusive task scheduling"):
                adapter.tasks(self.req)
        self.req["benchmark"]["config"]["suite"] = "nope"
        with self.assertRaisesRegex(ValueError, "Unknown BrowserGym suite"):
            adapter.tasks(self.req)

    def test_catalog_declares_supported_methods_and_fixed_conditions(self):
        self.req["benchmark"]["config"].update(actionSet="bid", maxSteps="7")
        caps = adapter.tasks(self.req)["capabilities"]
        self.assertEqual(caps["methods"], ["external", "empty"])
        self.assertEqual(caps["rescore"], "evidence")
        self.assertEqual(caps["conditions"]["Step limit"], "7")
        self.assertEqual(caps["conditions"]["Observation"], "Screenshot + accessibility tree")

    def test_review_preserves_post_action_frames_and_is_verified(self):
        out = self.episode()
        self.rows[0]["goal"] = "Click the button"
        self.save()
        review = evidence.trajectory_review(self.rows, self.result)
        evidence.write(out / "trajectory-review.json", review)
        self.result["sha256"]["trajectory-review.json"] = evidence.digest(out / "trajectory-review.json")
        evidence.write(out / "result.json", self.result)
        report = evidence.validate(out)
        evidence.write(Path(self.req["verify"]["output"]) / "validation.json", report)
        self.assertIsNone(review["steps"][0]["action"])
        self.assertEqual(review["steps"][1]["action"], "click('1')")
        self.assertEqual(review["steps"][1]["screenshot"], "screenshots/0001.png")
        self.assertEqual(adapter.score(self.req)["review"]["files"][0]["kind"], "trajectory")
        review["steps"][1]["screenshot"] = "screenshots/0000.png"
        evidence.write(out / "trajectory-review.json", review)
        with self.assertRaisesRegex(ValueError, "review disagrees"):
            evidence.validate(out)

    def test_plan_uses_official_files_seed_and_resolved_resources(self):
        self.req["trial"].update(resources={"cpus": 3, "memGB": 6}, timeoutMin=2)
        spec, plan = self.plan()
        self.assertEqual(spec["resources"], {"cpus": 3, "memGB": 6, "gpus": 0})
        self.assertEqual(spec["timeoutMin"], 2)
        self.assertEqual(plan["seed"], 1)
        self.assertEqual(spec["env"]["MINIWOB_URL"], "file:///miniwob/miniwob/")
        self.assertTrue(all(m["mode"] == "ro" for m in spec["mounts"]))
        self.assertNotIn("agentTask", spec)
        self.assertNotIn("passEnv", spec)

    def test_rejects_unsupported_methods_options_and_gpu(self):
        original = copy.deepcopy(self.req)
        for agent in ("oracle", "codex", "claude-code"):
            self.req = copy.deepcopy(original)
            self.req["trial"]["method"]["agent"] = agent
            with self.assertRaisesRegex(ValueError, "supports external and empty"):
                self.plan()
        self.req = copy.deepcopy(original)
        self.req["trial"]["resources"] = {"gpus": 1}
        with self.assertRaisesRegex(ValueError, "GPU"):
            self.plan()
        self.req = copy.deepcopy(original)
        self.req["trial"]["options"] = {"unknown": "ignored?"}
        with self.assertRaisesRegex(ValueError, "no trial options"):
            self.plan()

    def test_rejects_changed_official_checkout(self):
        with patch.object(adapter.subprocess, "check_output", return_value="wrong-revision"):
            with self.assertRaisesRegex(ValueError, "unmodified official"):
                adapter.solve(self.req)

    def test_captured_official_positive_and_empty_reward(self):
        self.episode()
        self.assertEqual(adapter.score(self.req)["score"], 1)
        self.rows[-1]["reward"] = self.rows[-1]["task_info"]["RAW_REWARD_GLOBAL"] = 0
        self.result["reward"] = 0
        self.save()
        evidence.write(self.root / "verify/validation.json", evidence.validate(self.out))
        self.assertEqual(adapter.score(self.req)["score"], 0)

    def test_tampered_or_missing_screenshot_is_invalid(self):
        self.episode()
        (self.out / "screenshots/0001.png").write_bytes(b"changed")
        self.assertTrue(adapter.score(self.req)["invalid"])
        (self.out / "screenshots/0001.png").unlink()
        self.assertTrue(adapter.score(self.req)["invalid"])

    def test_runtime_error_is_invalid_not_zero(self):
        self.episode()
        self.result.update(status="error", error_type="ConnectionError")
        self.save()
        score = adapter.score(self.req)
        self.assertTrue(score["invalid"])
        self.assertIsNone(score["score"])

    def test_leaving_task_page_keeps_the_original_valid_failure(self):
        self.episode(reward=0)
        self.rows[-1]["task_info"] = {"error": "invalid url, terminating task"}
        self.save()
        self.assertEqual(evidence.validate(self.out)["reward"], 0)
        self.rows[-1]["reward"] = self.result["reward"] = 1
        self.save()
        with self.assertRaisesRegex(ValueError, "original zero reward"):
            evidence.validate(self.out)

    def test_wrong_task_and_different_verifier_output_are_invalid(self):
        self.episode()
        self.req["trial"]["seed"] = 2
        self.assertTrue(adapter.score(self.req)["invalid"])
        self.req["trial"]["seed"] = 1
        evidence.write(self.root / "verify/validation.json", {"valid": True, "reward": 0})
        self.assertTrue(adapter.score(self.req)["invalid"])

    def test_incomplete_trajectory_and_changed_reward_rule_are_invalid(self):
        self.episode()
        self.rows[-1]["task_info"]["RAW_REWARD_GLOBAL"] = -1
        self.save()
        with self.assertRaisesRegex(ValueError, "original MiniWoB rule"):
            evidence.validate(self.out)
        self.rows.pop()
        self.save()
        with self.assertRaisesRegex(ValueError, "incomplete"):
            evidence.validate(self.out)

    def test_rescore_does_not_depend_on_trial_staging(self):
        self.episode()
        import shutil
        shutil.rmtree(self.root / "staging")
        self.assertFalse(adapter.score(self.req)["invalid"])
        spec = adapter.verify(self.req)["spec"]
        self.assertFalse(spec["network"])
        self.assertTrue(all("staging" not in m["source"] for m in spec["mounts"]))


if __name__ == "__main__":
    unittest.main()
