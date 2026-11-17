"""Explicit synthetic data fixtures; no model/API or native-scoring parity claim."""

import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import adapter

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench.questions import question_score
from orbit_bench.judged import prediction


class AdapterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.health = adapter.HERE.name == "healthbench"
        if self.health:
            row = {"prompt_id": "a", "prompt": [{"role": "user", "content": "Question"}],
                   "rubrics": [{"criterion": "Secret rubric", "points": 1, "tags": []}], "example_tags": []}
        else:
            row = {"question_id": "a", "question": "Question", "question_type": "single-session-user",
                   "answer": "Secret answer", "question_date": "2025-01-02", "haystack_dates": ["2025-01-01"],
                   "haystack_session_ids": ["session"], "answer_session_ids": ["session"],
                   "haystack_sessions": [[{"role": "user", "content": "History", "has_answer": True}]]}
        raw = json.dumps([row]); path = self.root / "data.json"; path.write_text(raw)
        self.req = {"benchmark": {"path": str(self.root), "config": {"image": "python:fixture", "data": str(path),
                    "dataSha256": hashlib.sha256(raw.encode()).hexdigest(), "variant": "oracle"}},
                    "trial": {"task": "a", "staging": str(self.root / "stage"), "method": {"agent": "codex"}},
                    "solve": {"output": str(self.root / "output")}, "verify": {"output": str(self.root / "verify")}}
        mock = patch.object(adapter, "checked_source", return_value={})
        mock.start(); self.addCleanup(mock.stop)

    def test_private_labels_and_full_history(self):
        run = adapter.solve(self.req)["spec"]
        self.assertIn("agentTask", run)
        visible = (self.root / "stage/solve/task.json").read_text()
        self.assertNotIn("Secret", visible)
        self.assertNotIn("has_answer", visible)
        self.assertNotIn("answer_session_ids", visible)
        if not self.health:
            self.assertIn("History", visible)
            self.assertIn("2025-01-01", visible)
        self.assertEqual(len(adapter.tasks(self.req)["tasks"]), 1)

    def test_data_drift_and_command_quoting(self):
        self.req["trial"]["method"] = {"agent": "external", "entrypoint": "python -c 'print(1)'"}
        self.assertEqual(adapter.solve(self.req)["spec"]["command"], ["python", "-c", "print(1)"])
        Path(self.req["benchmark"]["config"]["data"]).write_text("[]")
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            adapter.solve(self.req)

    def test_missing_answer_and_judge_failure_are_separate(self):
        self.assertEqual(prediction(self.root / "missing"), "")
        dest = self.root / "verify"; dest.mkdir()
        p = dest / "result.json"
        p.write_text(json.dumps({"task": "a", "error": "Unavailable", "failure": "judge_unavailable"}))
        self.assertEqual(question_score(self.req)["failure"], "judge_unavailable")
        p.write_text(json.dumps({"task": "a", "score": 0}))
        self.assertFalse(question_score(self.req)["invalid"])
        p.write_text(json.dumps({"task": "wrong", "score": 1}))
        self.assertTrue(question_score(self.req)["invalid"])


if __name__ == "__main__":
    unittest.main()
