"""Synthetic protocol regression checks; these do not validate native simulation scores."""

import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import adapter


class RLEAdapterTests(unittest.TestCase):
    def test_native_fault_markers_are_invalid_even_with_nonzero_reward(self):
        for marker in ("scoring_error", "harness_crash", "infra_error", "grader_error"):
            with self.subTest(marker=marker):
                result = self.score({"reward": 0.8, marker: 1})
                self.assertTrue(result["invalid"])
                self.assertEqual(result["failure"], "scorer_error")
                self.assertIsNone(result["score"])

    def test_empty_and_partial_rewards_preserve_native_value(self):
        for value in (0, 0.37, 1):
            result = self.score({"reward": value, "gated": 1, "scoring_error": 0})
            self.assertFalse(result["invalid"])
            self.assertEqual(result["score"], value)

    def test_malformed_rewards_are_invalid(self):
        for value in (True, "0.4", -1, 2, float("nan"), float("inf")):
            with self.subTest(value=value):
                self.assertTrue(self.score({"reward": value})["invalid"])

    def score(self, reward):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "collected/logs/verifier/reward.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps(reward))
            req = {"verify": {"output": directory, "run": {"spec": {}}}}
            native = {"score": reward.get("reward"), "maxScore": 1, "invalid": False,
                      "review": {"files": [], "items": [], "details": {}}}
            with patch.object(adapter, "delegate", return_value=native):
                return adapter.score(req)

    def test_review_keeps_declared_kinds_and_lists_stages_and_checkpoints(self):
        with tempfile.TemporaryDirectory() as directory:
            verifier = Path(directory) / "collected/logs/verifier"
            verifier.mkdir(parents=True)
            (verifier / "reward.json").write_text(json.dumps({"reward": 0.5}))
            (verifier / "report.json").write_text(json.dumps({
                "gate_failed": ["S1.load"], "stages": {"validity": 1.0, "design": "n/a"},
                "checkpoints": {"S1.load": 0.0, "S2.run": 0.5}}))
            files = [{"label": "Tests", "phase": "verify", "path": "collected/logs/verifier/ctrf.json",
                      "kind": "tests", "fallback": "json"},
                     {"label": "Test output", "phase": "verify", "path": "collected/logs/verifier/test-stdout.txt"}]
            native = {"score": 0.5, "maxScore": 1, "invalid": False,
                      "review": {"files": files, "items": [], "details": {}}}
            req = {"verify": {"output": directory, "run": {"spec": {}}}}
            with patch.object(adapter, "delegate", return_value=native):
                review = adapter.score(req)["review"]
        self.assertEqual([f["kind"] for f in review["files"]], ["tests", "text"])
        self.assertEqual([(i["criterion"], i["type"], i["score"]) for i in review["items"]],
                         [("validity", "stage", 1.0), ("S1.load", "checkpoint", 0.0), ("S2.run", "checkpoint", 0.5)])
        self.assertIn("Gate failed", review["items"][1]["reasoning"])
        self.assertNotIn("reasoning", review["items"][2])
        self.assertEqual(self.score({"reward": 1})["review"]["items"], [])

    def test_pin_images_recurses_and_rejects_unprepared_images(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "orbit-images.json"
            digest = "sha256:" + "a" * 64
            path.write_text(json.dumps({"revision": adapter.REVISION, "images": {"native:dev": digest}}))
            req = {"benchmark": {"path": directory, "config": {}}}
            spec = {"image": "native:dev", "services": [{"image": "native:dev"}]}
            adapter.pin_images(req, spec)
            self.assertEqual(spec["image"], digest)
            self.assertEqual(spec["services"][0]["image"], digest)
            with self.assertRaisesRegex(ValueError, "missing immutable"):
                adapter.pin_images(req, {"image": "unprepared:dev"})

    def test_catalog_requires_all_native_tasks_and_keeps_nested_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, "incomplete"):
                adapter.catalog(root)
            for family, count in adapter.COUNTS.items():
                for index in range(count):
                    directory = root / "tasks" / family
                    if count > 1:
                        directory /= f"case-{index}"
                    directory.mkdir(parents=True, exist_ok=True)
                    (directory / "task.toml").write_text("# synthetic catalog fixture")
            result = adapter.catalog(root)
            self.assertEqual(len(result), 51)
            self.assertEqual(result["task01/case-0"], "task01/case-0")
            self.assertEqual(result["task08"], "task08")

    def test_generated_instruction_change_invalidates_preparation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task = root / "tasks/task08"
            task.mkdir(parents=True)
            (task / "task.toml").write_text("# synthetic catalog fixture")
            instruction = task / "instruction.md"
            instruction.write_text("original fixture")
            lock = {"revision": adapter.REVISION, "digest": adapter.prepared_digest(root)}
            (root / "orbit-catalog.json").write_text(json.dumps(lock))
            adapter.check_prepared(root)
            instruction.write_text("modified fixture")
            with self.assertRaisesRegex(ValueError, "files changed"):
                adapter.check_prepared(root)

    def test_image_inputs_must_match_the_current_prepared_task(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task = root / "tasks/task08"
            task.mkdir(parents=True)
            (task / "task.toml").write_text("# synthetic catalog fixture")
            image = "rlebench-task08-agent:dev"
            lock = {"revision": adapter.REVISION, "images": {image: "sha256:" + "a" * 64},
                    "inputs": {image: adapter.prepared_digest(root, "task08")}}
            (root / "orbit-images.json").write_text(json.dumps(lock))
            req = {"benchmark": {"path": directory, "config": {}}}
            adapter.pin_images(req, {"image": image})
            (task / "instruction.md").write_text("modified fixture")
            with self.assertRaisesRegex(ValueError, "build inputs changed"):
                adapter.pin_images(req, {"image": image})

    def test_proven_native_submission_rejection_is_valid_zero(self):
        for kind in ("robot_size", "controller_size", "symlink", "directory"):
            with self.subTest(kind=kind):
                result = self.submission_rejection(kind)
                self.assertFalse(result["invalid"])
                self.assertEqual(result["score"], 0)
                self.assertNotIn("failure", result)

    def test_rejection_text_cannot_override_unknown_grader_failures(self):
        self.assertTrue(self.submission_rejection("small_file")["invalid"])
        self.assertTrue(self.submission_rejection("robot_size", native_stack=False)["invalid"])
        self.assertTrue(self.submission_rejection("robot_size", reward={"reward": 0.5, "scoring_error": 1})["invalid"])
        self.assertTrue(self.submission_rejection("robot_size", reward={"reward": 0, "scoring_error": 1, "infra_error": 1})["invalid"])
        self.assertTrue(self.submission_rejection("robot_size", reward={"reward": False, "scoring_error": 1})["invalid"])
        self.assertTrue(self.submission_rejection("directory", native_fdopen=False)["invalid"])

    def submission_rejection(self, kind, *, native_stack=True, native_fdopen=True, reward=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = root / "solve/collected/logs/artifacts"
            artifacts.mkdir(parents=True)
            verifier = root / "verify/collected/logs/verifier"
            verifier.mkdir(parents=True)
            name = "controller.py" if kind == "controller_size" else "robot.xml"
            path = artifacts / name
            if kind == "symlink":
                path.symlink_to("/unavailable-fixture-target")
                error = f"OSError: [Errno 40] Too many levels of symbolic links: '/logs/artifacts/{name}'"
            elif kind == "directory":
                path.mkdir()
                error = "IsADirectoryError: [Errno 21] Is a directory: 3"
            else:
                with path.open("wb") as file:
                    file.truncate(2 if kind == "small_file" else (1048577 if kind == "controller_size" else 4194305))
                error = f"ValueError: invalid submitted file: {name}"
            stack = '  File "/tests/score_task.py", line 56, in _stage_submission\n' if native_stack else ""
            if native_fdopen:
                stack += '    with os.fdopen(fd, "rb") as source:\n'
            (verifier / "test-stdout.txt").write_text(stack + error + "\n")
            reward = reward if reward is not None else {"reward": 0.0, "scoring_error": 1}
            (verifier / "reward.json").write_text(json.dumps(reward))
            req = {"trial": {"task": "task08"}, "solve": {"output": str(root / "solve")},
                   "verify": {"output": str(root / "verify"), "run": {"spec": {}}}}
            with patch.object(adapter, "delegate", return_value={"score": 0, "invalid": True}):
                return adapter.score(req)

    def test_unsafe_native_grader_is_rejected_at_all_execution_entries(self):
        req = {"trial": {"task": "task09"}}
        for operation in (adapter.solve, adapter.verify):
            with self.assertRaisesRegex(ValueError, "verifier UID"):
                operation(req)
        self.assertTrue(adapter.score(req)["invalid"])

    def test_solve_keeps_agent_task_and_upstream_budget(self):
        native = {"spec": {"image": "native:dev", "timeoutMin": 120,
                            "resources": {"gpus": 0, "cpus": 4, "memGB": 4},
                            "agentTask": {"instruction": "native instructions"}}}
        with patch.object(adapter, "delegate", return_value=copy.deepcopy(native)), \
                patch.object(adapter, "pin_images"):
            result = adapter.solve({"trial": {"task": "task08", "method": {"agent": "claude-code"}}})
        self.assertEqual(result["spec"]["agentTask"], native["spec"]["agentTask"])
        self.assertEqual(result["spec"]["timeoutMin"], 120)
        self.assertNotIn("command", result["spec"])
        self.assertIn(adapter.NETWORK_NOTE, result["issues"])


if __name__ == "__main__":
    unittest.main()
