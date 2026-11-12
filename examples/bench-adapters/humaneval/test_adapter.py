"""Explicit fixtures and the real check program; no Docker, no model."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import adapter

PROBLEM = {"task_id": "HumanEval/0", "prompt": "def add(a, b):\n    \"\"\"Add.\"\"\"\n", "entry_point": "add",
           "canonical_solution": "    return a + b\n",
           "test": "def check(f):\n    assert f(1, 2) == 3\n"}


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        raw = gzip.compress(json.dumps(PROBLEM).encode() + b"\n")
        (self.root / adapter.DATA).write_bytes(raw)
        patch = mock.patch.object(adapter, "DATA_SHA256", hashlib.sha256(raw).hexdigest())
        patch.start()
        self.addCleanup(patch.stop)
        self.req = {"benchmark": {"path": str(self.root), "config": {}},
                    "trial": {"task": "HumanEval/0", "seed": 1, "method": {"name": "o", "agent": "oracle"},
                              "staging": str(self.root / "st")}}

    def run_check(self, completion):
        out = self.root / "out"
        out.mkdir(exist_ok=True)
        (self.root / "c.json").write_text(json.dumps({"task_id": "HumanEval/0", "completion": completion}))
        (self.root / "p.json").write_text(json.dumps(PROBLEM))
        subprocess.run([sys.executable, str(adapter.HERE / "check.py"), str(self.root / "p.json"),
                        str(self.root / "c.json"), "3"], env={**os.environ, "ORBIT_OUTPUT": str(out)}, check=True)
        return json.loads((out / "result.json").read_text())["result"]

    def test_hidden_tests_and_solution_stay_out_of_the_subjects_view(self):
        self.req["trial"]["method"] = {"name": "e", "agent": "empty"}
        adapter.solve(self.req)
        seen = json.loads((self.root / "st/solve/problem.json").read_text())
        self.assertEqual(set(seen), {"task_id", "prompt"})

    def test_upstream_check_program(self):
        self.assertEqual(self.run_check("    return a + b\n"), "passed")
        self.assertTrue(self.run_check("").startswith("failed"))
        self.assertEqual(self.run_check("    while True: pass\n"), "timed out")

    def test_score_reads_the_check_and_refuses_a_foreign_result(self):
        v = self.root / "v"
        v.mkdir()
        (v / "result.json").write_text(json.dumps({"task_id": "HumanEval/0", "result": "passed"}))
        self.req.update(solve={"output": str(self.root)}, verify={"output": str(v)})
        self.assertEqual((adapter.score(self.req)["score"], adapter.score(self.req)["invalid"]), (1.0, False))
        self.assertEqual(adapter.score(self.req)["review"]["items"][0]["score"], 1)
        (v / "result.json").write_text(json.dumps({"task_id": "HumanEval/0", "result": "failed: AssertionError"}))
        item = adapter.score(self.req)["review"]["items"][0]
        self.assertEqual((item["score"], item["maxScore"], item["reasoning"]), (0, 1, "AssertionError"))
        (v / "result.json").write_text(json.dumps({"task_id": "HumanEval/0", "result": "timed out"}))
        self.assertEqual(adapter.score(self.req)["review"]["items"][0]["reasoning"], "timed out")
        (v / "result.json").write_text(json.dumps({"task_id": "HumanEval/9", "result": "passed"}))
        self.assertEqual(adapter.score(self.req)["failure"], "scorer_error")

    def test_other_data_is_refused(self):
        (self.root / adapter.DATA).write_bytes(gzip.compress(b"{}\n"))
        with self.assertRaisesRegex(ValueError, "not the pinned"):
            adapter.tasks(self.req)


if __name__ == "__main__":
    unittest.main()
