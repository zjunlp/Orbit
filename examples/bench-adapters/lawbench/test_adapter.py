"""Explicit synthetic fixtures; no upstream grader is replaced in real checks."""

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
        files = {
            "evaluation/main.py": "def main():\n    funct_dict = {'1-2': jec_kd.compute_jec_kd, '2-1': wsjd.compute_wsjd}\n",
            "evaluation/evaluation_functions/jec_kd.py": "# Explicit fixture, not a real evaluator.\n",
            "data/zero_shot/1-2.json": json.dumps([{"instruction": "Choose an option", "question": "Question",
                                                  "answer": "Secret reference"}]),
        }
        release = {"revision": "fixture", "files": {}}
        for path, source in files.items():
            dest = self.root / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(source)
            raw = source.encode()
            release["files"][path] = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
        mock = patch.object(adapter, "RELEASE", release)
        mock.start()
        self.addCleanup(mock.stop)
        self.req = {"benchmark": {"path": str(self.root), "config": {}},
                    "trial": {"task": "1-2", "staging": str(self.root / "stage"), "method": {"agent": "codex"}},
                    "solve": {"output": str(self.root / "output")}, "verify": {"output": str(self.root)}}

    def test_mapping_is_native_and_unsupported_is_explicit(self):
        rows = adapter.tasks(self.req)["tasks"]
        self.assertEqual([r["supported"] for r in rows], [True, False])
        self.assertIn("ChERRANT", rows[1]["reason"])
        self.assertEqual(adapter.functions(self.req)["1-2"], ("jec_kd", "compute_jec_kd"))

    def test_solve_cannot_see_labels_and_data_mutation_is_rejected(self):
        run = adapter.solve(self.req)["spec"]
        self.assertIn("agentTask", run)
        self.assertNotIn("Secret reference", (self.root / "stage/solve/task.json").read_text())
        (self.root / "data/zero_shot/1-2.json").write_text("[]")
        with self.assertRaisesRegex(ValueError, "differs"):
            adapter.problem(self.req)

    def test_empty_submission_and_native_scorer_error(self):
        self.assertEqual(runtime.predictions(self.root / "missing", 2), ["", ""])
        result = self.root / "result.json"
        result.write_text(json.dumps({"task": "1-2", "score": 0}))
        self.assertFalse(adapter.score(self.req)["invalid"])
        result.write_text(json.dumps({"task": "1-2", "error": "native assertion failed"}))
        self.assertEqual(adapter.score(self.req)["failure"], "scorer_error")


if __name__ == "__main__":
    unittest.main()
