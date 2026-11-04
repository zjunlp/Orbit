"""Explicit file and API fixtures, not Android emulator integration checks."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import adapter
import evidence
import runtime


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        source = self.root / "src/mobile_world/tasks/definitions/native"
        source.mkdir(parents=True)
        (source / "tasks.py").write_text('''class Plain(BaseTask):
    task_tags = {"lang-en"}
    app_names = {"Clock"}
class User(BaseTask):
    task_tags = {"lang-en", "agent-user-interaction"}
    app_names = {"Clock"}
class Online(BaseTask):
    task_tags = {"lang-en"}
    app_names = {"Chrome"}
''')
        self.request = {"benchmark": {"path": str(self.root), "config": {"image": "ghcr.io/tongyi-mai/mobile_world@sha256:" + "a" * 64}},
                        "trial": {"task": "Plain", "method": {"agent": "empty", "name": "empty"}, "seed": 1,
                                  "staging": str(self.root / "staging"), "resources": {"cpus": 4, "memGB": 8, "gpus": 0}}}

    def test_catalog_retains_ineligible_tasks(self):
        with patch.object(adapter, "checkout"), patch.object(adapter, "prerequisites", return_value=[]):
            tasks = adapter.tasks(self.request)["tasks"]
        self.assertEqual(len(tasks), 3)
        self.assertEqual([row["id"] for row in tasks if row["supported"]], ["Plain"])
        self.assertTrue(all(row["reason"] for row in tasks if not row["supported"]))

    def test_missing_kvm_refuses_solve(self):
        with patch.object(adapter, "checkout"), patch.object(adapter, "prerequisites", return_value=["KVM unavailable"]):
            self.assertTrue(all(not row["supported"] for row in adapter.tasks(self.request)["tasks"]))
            with self.assertRaisesRegex(ValueError, "KVM unavailable"):
                adapter.solve(self.request)

    def test_plan_preserves_one_task_and_resource_override(self):
        with patch.object(adapter, "checkout"), patch.object(adapter, "prerequisites", return_value=[]):
            spec = adapter.solve(self.request)["spec"]
        self.assertEqual(spec["backend"], "process")
        plan = evidence.read(self.root / "staging/plan.json")
        self.assertEqual(spec["resources"], self.request["trial"]["resources"])
        args = runtime.native_arguments(plan, "http://127.0.0.1:6800", self.root, "empty.py")
        for flag, value in (("--task", "Plain"), ("--max-concurrency", "1"), ("--pass-k", "1"), ("--auto-retry", "0")):
            self.assertEqual(args[args.index(flag) + 1], value)
        self.assertNotIn("--api-key", args)

    def test_internal_retry_disabled_and_second_reset_refused(self):
        runner = SimpleNamespace(_process_task_on_env=lambda **kwargs: kwargs)
        class Client:
            def initialize_task(self): return "observation"
            def execute_action(self): return "observation"
            def get_task_score(self): return 0, "empty"
        response = SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"score": 0})
        requests = SimpleNamespace(get=lambda *args, **kwargs: response)
        result = {"initializations": 0, "evaluations": 0}
        runtime.install_episode_guards(runner, Client, requests, result)
        self.assertEqual(runner._process_task_on_env()["retry_on_device_unhealthy"], 0)
        client = Client()
        client.initialize_task()
        with self.assertRaisesRegex(RuntimeError, "second episode"):
            client.initialize_task()
        response.json = lambda: {"reason": "missing score"}
        with self.assertRaisesRegex(ValueError, "finite score"):
            requests.get("http://example/task/eval")

    def test_known_secret_redaction_preserves_binary_artifacts(self):
        text = self.root / "native.log"
        image = self.root / "frame.png"
        text.write_text("provider error: fixture-secret-value")
        image.write_bytes(b"fixture-secret-value")
        evidence.redact_text_artifacts(self.root, ["fixture-secret-value"])
        self.assertNotIn("fixture-secret-value", text.read_text())
        self.assertEqual(image.read_bytes(), b"fixture-secret-value")

    def test_gui_frames_use_previous_action_and_do_not_invent_tail(self):
        rows = [{"step": 1, "task_goal": "fixture goal", "action": {"action_type": "click", "x": 5, "y": 8}},
                {"step": 2, "action": {"action_type": "finished"}}]
        view = evidence.trajectory_review("Plain", rows)
        self.assertEqual(len(view["steps"]), 2)
        self.assertIsNone(view["steps"][0]["action"])
        self.assertEqual(json.loads(view["steps"][1]["action"]), rows[0]["action"])
        self.assertTrue(view["steps"][1]["screenshot"].endswith("Plain-0-2.png"))
        self.assertTrue(all(row["reward"] is None for row in view["steps"]))
        self.assertIn("no captured resulting frame", view["stopReason"])

    def saved(self):
        task = self.root / "native/Plain"
        (task / "screenshots").mkdir(parents=True)
        (task / "screenshots/Plain-0-1.png").write_bytes(b"explicit screenshot fixture")
        plan = {"schema": 1, "source": adapter.COMMIT, "task": "Plain", "seed": 1,
                "method": self.request["trial"]["method"], "max_steps": 3}
        evidence.write(self.root / "plan.json", plan)
        evidence.write(task / "traj.json", {"0": {"traj": [{"step": 1, "action": {"action_type": "finished"}}]}})
        (task / "result.txt").write_text("score: 0.0\nreason: Empty")
        evidence.write(self.root / "trajectory-review.json", evidence.trajectory_review("Plain", evidence.read(task / "traj.json")["0"]["traj"]))
        files = ["trajectory-review.json", "plan.json", "native/Plain/traj.json", "native/Plain/result.txt", "native/Plain/screenshots/Plain-0-1.png"]
        result = {"status": "completed", "score": 0, "steps": 1, "initializations": 1, "evaluations": 1,
                  "sha256": {name: evidence.digest(self.root / name) for name in files}}
        evidence.write(self.root / "result.json", result)
        return result

    def test_saved_score_and_tampering(self):
        self.saved()
        self.assertEqual(evidence.validate(self.root)["score"], 0)
        (self.root / "native/Plain/result.txt").write_text("score: 1\nreason: changed")
        with self.assertRaises(ValueError): evidence.validate(self.root)

    def test_failed_evaluator_is_invalid_not_zero(self):
        self.saved()
        evidence.write(self.root / "result.json", {"status": "error", "failure": "scorer_error"})
        self.request.update(solve={"output": str(self.root)}, verify={"output": str(self.root)})
        result = adapter.score(self.request)
        self.assertTrue(result["invalid"])
        self.assertIsNone(result["score"])
        self.assertEqual(result["failure"], "scorer_error")

    def test_nonfinite_score_and_duplicate_episode_rejected(self):
        with self.assertRaises(ValueError): evidence.original_score("score: nan\nreason: broken")
        result = self.saved()
        result["initializations"] = 2
        evidence.write(self.root / "result.json", result)
        with self.assertRaises(ValueError): evidence.validate(self.root)


if __name__ == "__main__": unittest.main()
