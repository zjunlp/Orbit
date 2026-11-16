"""Explicit synthetic fixtures; real native calibration is reported separately."""

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import adapter
import runtime


class AdapterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        sources = {"tasks.py": "TASKS = ['classification', 'rule_qa', 'missing']\n",
                   "evaluation.py": "MANUAL_EVAL_TASKS = ['rule_qa']\n"}
        hashes = {}
        for name, source in sources.items():
            (self.root / name).write_text(source)
            raw = source.encode()
            hashes[name] = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
        mock = patch.dict(adapter.SOURCE_HASHES, hashes)
        mock.start()
        self.addCleanup(mock.stop)
        task = self.root / "tasks/classification"
        task.mkdir(parents=True)
        (task / "base_prompt.txt").write_text("Answer the legal question: {{text}}")
        (task / "test.tsv").write_text("text\tanswer\nQuestion A\tSecret A\nQuestion B\tSecret B\n")
        pins = {}
        for path in task.iterdir():
            raw = path.read_bytes()
            pins[str(path.relative_to(self.root))] = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
        mock = patch.dict(adapter.RELEASE["files"], pins)
        mock.start()
        self.addCleanup(mock.stop)
        self.req = {"benchmark": {"path": str(self.root), "config": {"image": "python:fixture"}},
                    "trial": {"task": "classification", "staging": str(self.root / "stage"),
                              "method": {"agent": "codex"}},
                    "solve": {"output": str(self.root / "output")},
                    "verify": {"output": str(self.root / "verify")}}

    def test_complete_catalog_and_source_pin(self):
        rows = adapter.tasks(self.req)["tasks"]
        self.assertEqual([r["supported"] for r in rows], [True, False, False])
        self.assertIn("human", rows[1]["reason"])
        (self.root / "evaluation.py").write_text("MANUAL_EVAL_TASKS = []")
        with self.assertRaisesRegex(ValueError, "differs"):
            adapter.tasks(self.req)

    def test_labels_are_hidden_from_agent_and_rescore_checks_inputs(self):
        run = adapter.solve(self.req)["spec"]
        self.assertIn("agentTask", run)
        self.assertNotIn("command", run)
        visible = self.root / "stage/solve/task.json"
        self.assertNotIn("Secret", visible.read_text())
        saved = self.root / "output/collected/input/task.json"
        saved.parent.mkdir(parents=True)
        saved.write_bytes(visible.read_bytes())
        verify = adapter.verify(self.req)["spec"]
        self.assertFalse(verify["network"])
        self.assertIn("Secret", (self.root / "stage/verify/task.json").read_text())
        (self.root / "tasks/classification/test.tsv").write_text("text\tanswer\nChanged\tSecret C\n")
        with self.assertRaisesRegex(ValueError, "differs from LegalBench"):
            adapter.verify(self.req)

    def test_missing_malformed_and_partial_answers(self):
        path = self.root / "answers.json"
        self.assertEqual(runtime.predictions(path, 2), ["", ""])
        path.write_text('{"0": "yes", "1": 9, "extra": "no"}')
        self.assertEqual(runtime.predictions(path, 3), ["yes", "", ""])
        path.write_text('[]')
        self.assertEqual(runtime.predictions(path, 1), [""])

    def test_invalid_grader_is_separate_from_zero(self):
        dest = self.root / "verify"
        dest.mkdir()
        result = dest / "result.json"
        self.assertTrue(adapter.score(self.req)["invalid"])
        result.write_text(json.dumps({"task": "classification", "score": 0}))
        self.assertFalse(adapter.score(self.req)["invalid"])
        result.write_text(json.dumps({"task": "classification", "error": "native grader failed"}))
        self.assertEqual(adapter.score(self.req)["failure"], "scorer_error")
        result.write_text(json.dumps({"task": "different", "score": 1}))
        self.assertTrue(adapter.score(self.req)["invalid"])


if __name__ == "__main__":
    unittest.main()
