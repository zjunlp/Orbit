"""Explicit fixture planning tests; native Docker checks are recorded separately."""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import adapter


class AdapterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.req = {"benchmark": {"path": str(self.root), "config": {"image": "native:fixture"}},
                    "trial": {"task": "banking/user_task_0", "staging": str(self.root / "stage"),
                              "method": {"agent": "codex"}},
                    "solve": {"output": str(self.root / "output")}, "verify": {"output": str(self.root / "verify")}}
        mock = patch.object(adapter, "catalog", return_value=["banking/user_task_0"])
        mock.start(); self.addCleanup(mock.stop)

    def test_subject_cannot_mount_private_native_code_or_scores(self):
        spec = adapter.solve(self.req)["spec"]
        self.assertIn("agentTask", spec)
        self.assertEqual(len(spec["mounts"]), 1)
        self.assertEqual(spec["mounts"][0]["target"], "/adapter/tool.py")
        service = spec["services"][0]
        self.assertEqual(service["networks"], ["tools"])
        self.assertEqual(service["collect"], ["/evidence/trace.json"])
        self.assertIn("/native", [m["target"] for m in service["binds"]])
        self.assertEqual(spec["networks"], [{"name": "tools", "internal": True}])
        self.assertFalse(adapter.verify(self.req)["spec"]["network"])

    def test_empty_and_external_commands(self):
        self.req["trial"]["method"] = {"agent": "empty"}
        baseline = adapter.solve(self.req)["spec"]
        self.assertEqual(baseline["command"][-1], "baseline")
        self.assertNotIn("services", baseline)
        self.req["trial"]["method"] = {"agent": "external", "entrypoint": "python -c 'print(1)'"}
        self.assertEqual(adapter.solve(self.req)["spec"]["command"], ["python", "-c", "print(1)"])
        self.req["trial"]["method"]["entrypoint"] = "  "
        with self.assertRaises(ValueError): adapter.solve(self.req)

    def test_native_score_failure_and_identity(self):
        dest = self.root / "verify"; dest.mkdir(); p = dest / "result.json"
        self.assertTrue(adapter.score(self.req)["invalid"])
        p.write_text(json.dumps({"task": "banking/user_task_0", "utility": False}))
        self.assertEqual(adapter.score(self.req)["score"], 0)
        p.write_text(json.dumps({"task": "banking/user_task_0", "utility": "true"}))
        self.assertTrue(adapter.score(self.req)["invalid"])


if __name__ == "__main__": unittest.main()
