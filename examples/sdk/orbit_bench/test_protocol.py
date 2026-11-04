"""SDK protocol tests with explicit handlers (no Orbit, no Docker)."""
import io
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from orbit_bench import invalid, main, pinned, valid  # noqa: E402


def handlers():
    return (lambda r: {"tasks": [{"id": "t", "title": None, "supported": True, "reason": None}]},
            lambda r: {"spec": {"image": "x", "command": ["true"]}},
            lambda r: {"spec": {"image": "x", "command": ["true"]}},
            lambda r: valid(float("nan")))


class ProtocolTests(unittest.TestCase):
    def call(self, op, req):
        out, err = io.StringIO(), io.StringIO()
        code = main(*handlers(), argv=[op], stdin=io.StringIO(json.dumps(req)), stdout=out, stderr=err)
        return code, out.getvalue(), err.getvalue()

    def test_answers_a_matching_request(self):
        code, out, _ = self.call("tasks", {"protocol": 1, "op": "tasks"})
        self.assertEqual((code, json.loads(out)["tasks"][0]["id"]), (0, "t"))

    def test_errors_exit_non_zero_with_a_message(self):
        for op, req in (("tasks", {"protocol": 2, "op": "tasks"}), ("nope", {}),
                        ("score", {"protocol": 1, "op": "score"})):
            code, out, err = self.call(op, req)
            self.assertEqual((code, out), (1, ""))
            self.assertTrue(err.strip())

    def test_replies(self):
        self.assertEqual(valid(0)["invalid"], False)
        self.assertEqual(invalid("env_step", "sim crashed")["failure"], "env_step")
        with self.assertRaises(ValueError):
            invalid("crashed")
        self.assertTrue(pinned("ghcr.io/x/y@sha256:" + "a" * 64))
        self.assertFalse(pinned("ghcr.io/x/y:latest"))


if __name__ == "__main__":
    unittest.main()
