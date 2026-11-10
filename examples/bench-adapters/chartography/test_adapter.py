import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import adapter


class AdapterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        pack = self.root / "pack"
        pack.mkdir()
        (pack / "manifest.yaml").write_text("tasks: []")
        catalog = {"revision": adapter.REVISION, "packSha256": "pack", "tasks": [
            {"id": "sample_task_1", "title": "Explicit fixture", "domain": "test"}]}
        raw = json.dumps(catalog).encode()
        (self.root / "catalog.json").write_bytes(raw)
        self.req = {"benchmark": {"path": str(self.root), "config": {
            "image": "sha256:" + "a" * 64, "catalogSha256": hashlib.sha256(raw).hexdigest(),
            "taskPack": str(pack), "variant": "sample"}},
            "trial": {"task": "sample_task_1", "staging": str(self.root / "staging"),
                      "method": {"name": "empty", "agent": "empty"}},
            "solve": {"output": str(self.root)}, "verify": {"output": str(self.root)}}

    def test_dataset_and_no_tools_protocol(self):
        result = adapter.tasks(self.req)
        self.assertEqual(result["capabilities"]["identity"]["variant"], "sample")
        self.assertFalse(adapter.plan(self.req, "solve")["spec"]["network"])
        self.assertTrue(adapter.plan(self.req, "verify")["spec"]["network"])
        self.req["trial"]["method"] = {"name": "model", "agent": "claude-code"}
        with self.assertRaisesRegex(ValueError, "no-tools"):
            adapter.plan(self.req, "solve")

    def evidence(self):
        raw = b'{"fixture":true}'
        (self.root / "response.json").write_bytes(raw)
        report = {"task": "sample_task_1", "packSha256": "pack", "revision": adapter.REVISION,
                  "responseSha256": hashlib.sha256(raw).hexdigest(), "score": 1,
                  "judgeModel": "google/gemini-3.5-flash"}
        (self.root / "verdict.json").write_text(json.dumps(report))
        return report

    def test_grader_identity_and_errors(self):
        report = self.evidence()
        self.assertFalse(adapter.score(self.req)["invalid"])
        report["judgeModel"] = "different"
        (self.root / "verdict.json").write_text(json.dumps(report))
        self.assertTrue(adapter.score(self.req)["invalid"])
        (self.root / "verdict.json").write_text('{"invalid":true,"error":"unscored"}')
        self.assertIsNone(adapter.score(self.req)["score"])
        (self.root / "verdict.json").unlink()
        self.assertTrue(adapter.score(self.req)["invalid"])


if __name__ == "__main__":
    unittest.main()
