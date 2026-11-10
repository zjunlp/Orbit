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
        catalog = {"revision": adapter.REVISION, "tasks": [
            {"id": "sales.task", "contract": "c"}, {"id": "simple.task", "contract": "s"},
            {"id": "unknown.task", "contract": "u"}]}
        raw = json.dumps(catalog).encode()
        (self.root / "catalog.json").write_bytes(raw)
        self.req = {"benchmark": {"path": str(self.root), "config": {
            "image": "sha256:" + "a" * 64, "catalogSha256": hashlib.sha256(raw).hexdigest()}},
            "trial": {"task": "sales.task", "staging": str(self.root / "staging"),
                      "method": {"name": "empty", "agent": "empty"}},
            "solve": {"output": str(self.root)}, "verify": {"output": str(self.root)}}

    def test_disjoint_catalogs_and_integrity(self):
        self.assertEqual([r["id"] for r in adapter.tasks(self.req)["tasks"]], ["sales.task"])
        self.req["benchmark"]["config"]["split"] = "simple"
        self.assertEqual([r["id"] for r in adapter.tasks(self.req)["tasks"]], ["simple.task"])
        (self.root / "catalog.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "digest"):
            adapter.tasks(self.req)

    def test_native_method_only_and_offline_verification(self):
        self.req["trial"]["method"] = {"name": "model", "agent": "external", "entrypoint": "auto-bench", "model": "model", "config": {"baseUrl": "https://provider.example/v1"}}
        self.assertTrue(adapter.plan(self.req, "solve")["spec"]["network"])
        spec = adapter.plan(self.req, "verify")["spec"]
        self.assertFalse(spec["network"])
        self.assertNotIn("passEnv", spec)
        self.assertNotIn("AUTOMATIONBENCH_API_KEY", spec["env"])
        self.req["trial"]["method"] = {"name": "oracle", "agent": "oracle"}
        with self.assertRaisesRegex(ValueError, "external"):
            adapter.plan(self.req, "solve")

    def evidence(self):
        raw = b'{"fixture":true}'
        (self.root / "native.json").write_bytes(raw)
        report = {"task": "sales.task", "contract": "c", "revision": adapter.REVISION,
                  "nativeSha256": hashlib.sha256(raw).hexdigest(), "score": 0, "partial_credit": .5}
        (self.root / "verdict.json").write_text(json.dumps(report))
        return report

    def test_valid_zero_partial_credit_and_failed_evidence(self):
        self.evidence()
        result = adapter.score(self.req)
        self.assertFalse(result["invalid"])
        self.assertEqual(result["score"], 0)
        self.assertEqual(result["metrics"]["partial_credit"], 50)
        (self.root / "native.json").write_text("changed")
        self.assertTrue(adapter.score(self.req)["invalid"])
        (self.root / "verdict.json").write_text('{"invalid":true,"error":"API failed"}')
        self.assertIsNone(adapter.score(self.req)["score"])


if __name__ == "__main__":
    unittest.main()
