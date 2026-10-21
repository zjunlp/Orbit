import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import adapter
import runtime


class LongDSTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="orbit-longds-test-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.task = "business/fixture/task1"
        self.turns = [
            {"turn_id": 1, "context": "Initial context", "question": "First question", "answer": "A"},
            {"turn_id": 3, "context": "Later context", "question": "Future question", "answer": "B"},
        ]
        entries = [dict(zip(adapter.IDENTITY, self.task.split("/")))]
        self.req = {"protocol": 1, "op": "solve", "benchmark": {
            "path": str(self.root), "config": {"image": "fixture:latest"}},
            "trial": {"id": "trial", "task": self.task, "seed": 0, "options": {},
                      "method": {"name": "test", "agent": "codex", "model": "model", "effort": "low"},
                      "staging": str(self.root / "staging"), "hostNetwork": False},
            "solve": {"output": str(self.root / "solve")},
            "verify": {"output": str(self.root / "verify")}}
        for version in ("v1", "v1.1"):
            task_root = self.root / "dataset/task" / f"longds_{version}"
            for split in ("full", "lite"):
                adapter.write(task_root / f"task_list_{split}.json", entries)
            adapter.write(task_root / self.task / "task.json", self.turns)
        adapter.write(self.root / "dataset/data/longds" / self.task / "data/file.json", [1, 2])
        for runner in adapter.RUNNERS.values():
            path = self.root / "runners" / runner
            path.parent.mkdir(parents=True)
            path.write_text("# Explicit fake native runner for planning tests.\n")
        for name in ("judge.py", "judge_prompt.py", "longds_dataset.py", "__init__.py"):
            path = self.root / "runners/src" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("# Explicit fake upstream source for snapshot tests.\n")

    def plan(self):
        adapter.solve(self.req)
        return adapter.read(self.root / "staging/longds-plan.json")

    def result(self, values=(1, 0)):
        plan = self.plan()
        adapter.write(self.root / "solve/selection.json", plan)
        rows = [{"turn_id": t["turn_id"], "judge": {"score": v, "error": None}}
                for t, v in zip(self.turns, values)]
        rows.append({"summary": {"correct": sorted(t["turn_id"] for t, v in zip(self.turns, values) if v),
                                 "incorrect": sorted(t["turn_id"] for t, v in zip(self.turns, values) if not v),
                                 "avg_score": sum(values) / len(values)}})
        return rows

    def score(self, rows):
        adapter.write(self.root / "verify/task/results_eval.json", rows)
        return adapter.score(self.req)

    def test_all_versions_and_splits_have_explicit_task_identity(self):
        for version in ("v1", "v1.1"):
            for split in ("full", "lite"):
                self.req["benchmark"]["config"].update(version=version, split=split)
                task = adapter.tasks(self.req)["tasks"][0]
                self.assertTrue(task["supported"])
                self.assertEqual(task["tags"], {"domain": "business", "version": version,
                                                "split": split, "turns": "2"})
        self.req["benchmark"]["config"]["version"] = "missing"
        with self.assertRaises(FileNotFoundError):
            adapter.tasks(self.req)

    def test_missing_data_is_explicitly_unsupported(self):
        path = self.root / "dataset/data/longds" / self.task / "data/file.json"
        path.unlink()
        self.assertFalse(adapter.tasks(self.req)["tasks"][0]["supported"])
        with self.assertRaisesRegex(ValueError, "Missing task data"):
            self.plan()

    def test_malformed_turns_and_path_traversal_are_rejected(self):
        for turns in ([], [{"question": "q"}], [self.turns[0], self.turns[0]],
                      [{**self.turns[0], "turn_id": True}]):
            with self.subTest(turns=turns), self.assertRaises(ValueError):
                adapter.validate_turns(turns)
        for value in ("..", "a/b", "a\\b", ""):
            with self.assertRaises(ValueError):
                adapter.component(value)

    def test_native_plan_keeps_all_turns_and_resolved_resource_limits(self):
        self.req["trial"].update(resources={"cpus": 2.5, "memGB": 3, "gpus": 0}, timeoutMin=9)
        spec = adapter.solve(self.req)["spec"]
        plan = self.plan()
        command = runtime.native_command(plan, self.root / "solve")
        self.assertEqual(spec["resources"], {"cpus": 2.5, "memGB": 3, "gpus": 0})
        self.assertEqual(spec["timeoutMin"], 9)
        for flag, value in (("--docker-cpus", "2.5"), ("--docker-memory", str(3 * 1024**3)),
                            ("--reasoning-effort", "low"), ("--codex-model", "model")):
            self.assertEqual(command[command.index(flag) + 1], value)
        self.assertIn("--use-docker", command)
        self.assertNotIn("--turn-limit", command)
        self.assertNotIn("--judge", command)
        self.assertNotIn("Future question", " ".join(command))
        self.assertNotIn("--codex-auth", command)
        self.assertEqual(plan["turns"], self.turns)
        self.assertEqual(adapter.verify(self.req)["spec"]["timeoutMin"], 120)

    def test_claude_model_and_effort_are_forwarded(self):
        self.req["trial"]["method"].update(agent="claude-code", effort="high")
        command = runtime.native_command(self.plan(), self.root / "solve")
        self.assertIn("CLAUDE_CODE_EFFORT_LEVEL=high", command)
        self.assertEqual(command[command.index("--claude-model") + 1], "model")

    def test_unsupported_controls_are_not_silently_ignored(self):
        for change in ({"options": {"turnLimit": "1"}}, {"resources": {"gpus": 1}},
                       {"method": {"name": "x", "agent": "codex", "effort": "nonsense"}}):
            req = copy.deepcopy(self.req)
            req["trial"].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                adapter.solve(req)
        self.req["benchmark"]["config"]["turnLimit"] = "1"
        with self.assertRaisesRegex(ValueError, "Unknown LongDS config"):
            adapter.tasks(self.req)

    def test_per_turn_mean_and_empty_answers_are_valid(self):
        self.assertEqual(self.score(self.result())["score"], 0.5)
        zero = self.score(self.result((0, 0)))
        self.assertFalse(zero["invalid"])
        self.assertEqual(zero["score"], 0)

    def test_partial_duplicate_malformed_or_failed_judges_are_invalid(self):
        original = self.result()
        variants = []
        variants.append(original[:-2] + original[-1:])
        for value in (True, 0.5, None, "1", 2):
            rows = copy.deepcopy(original)
            rows[0]["judge"]["score"] = value
            variants.append(rows)
        for error in ("API timeout", ""):
            rows = copy.deepcopy(original)
            rows[0]["judge"]["error"] = error
            variants.append(rows)
        rows = copy.deepcopy(original)
        del rows[0]["judge"]["error"]
        variants.append(rows)
        rows = copy.deepcopy(original)
        rows[1]["turn_id"] = 1
        variants.append(rows)
        rows = copy.deepcopy(original)
        rows[-1]["summary"]["avg_score"] = 1
        variants.append(rows)
        rows = copy.deepcopy(original)
        rows[-1]["summary"]["avg_score"] = float("nan")
        variants.append(rows)
        for rows in variants:
            with self.subTest(rows=rows):
                result = self.score(rows)
                self.assertTrue(result["invalid"])
                self.assertIsNone(result["score"])

    def test_partial_or_failed_native_execution_cannot_be_scored(self):
        plan = self.plan()
        rows = [{"turn_id": t["turn_id"], "question": t["question"], "context": t["context"],
                 "solution": "A", "success": True} for t in self.turns]
        runtime.checked_results(plan, rows)
        with self.assertRaisesRegex(ValueError, "every task turn"):
            runtime.checked_results(plan, rows[:1])
        rows[1]["success"] = False
        with self.assertRaisesRegex(ValueError, "execution failed"):
            runtime.checked_results(plan, rows)

    def test_calibration_snapshots_are_self_contained_and_explicit(self):
        for agent in ("empty", "oracle"):
            self.req["trial"]["method"]["agent"] = agent
            self.plan()
            output = self.root / agent
            output.mkdir()
            runtime.solve(self.root / "staging/longds-plan.json", output)
            plan = adapter.read(output / "selection.json")
            rows = adapter.read(output / plan["nativePath"] / "results.json")
            self.assertEqual([r["solution"] for r in rows], ["", ""] if agent == "empty" else ["A", "B"])
            self.assertEqual(len(plan["judgeSources"]), 4)
            self.assertEqual(adapter.read(output / "inputs/longds_v1.1" / self.task / "task.json"), self.turns)
            self.assertEqual((output / "inputs/config.toml").read_text(), "")

    def test_verify_rebuilds_ground_truth_without_changing_saved_solve(self):
        self.req["trial"]["method"]["agent"] = "oracle"
        self.plan()
        output = self.root / "solve"
        output.mkdir()
        runtime.solve(self.root / "staging/longds-plan.json", output)
        plan = adapter.read(output / "selection.json")
        results = output / plan["nativePath"] / "results.json"
        rows = adapter.read(results)
        rows[0]["ground_truth"] = "untrusted replacement"
        adapter.write(results, rows)
        before = results.read_bytes()
        with patch.object(runtime, "load_judge", side_effect=RuntimeError("Stop before judging")):
            with self.assertRaisesRegex(RuntimeError, "Stop before judging"):
                runtime.verify(output, self.root / "verify", 1, 1)
        rebuilt = adapter.read(self.root / "verify/task/results_with_ground_truth.json")
        self.assertEqual([r["ground_truth"] for r in rebuilt], ["A", "B"])
        self.assertEqual(results.read_bytes(), before)
        self.assertFalse((output / "task/results_eval.json").exists())

    def test_changed_saved_judge_sources_are_rejected_before_import(self):
        self.req["trial"]["method"]["agent"] = "empty"
        self.plan()
        output = self.root / "solve"
        output.mkdir()
        runtime.solve(self.root / "staging/longds-plan.json", output)
        plan = adapter.read(output / "selection.json")
        (output / "upstream/src/judge.py").write_text("raise RuntimeError('must not execute')")
        with self.assertRaisesRegex(ValueError, "Saved upstream judge source changed"):
            runtime.load_judge(output, plan)


if __name__ == "__main__":
    unittest.main()
