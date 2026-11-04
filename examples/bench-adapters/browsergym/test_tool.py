"""Tool tests with explicit transport and filesystem fixtures, not real MCP execution."""

import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("computer_tool", Path(__file__).resolve().parents[2] / "tools/orbit-computer/orbit-computer.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


class ToolTests(unittest.TestCase):
    def test_action_id_is_preserved_and_proxy_environment_is_not_used(self):
        class Opener:
            def open(self, request, timeout):
                self.payload = json.loads(request.data)
                self.url = request.full_url
                return io.BytesIO(b'{"id":"fixture-id","step":1}')
        opener = Opener()
        with patch.dict(os.environ, {"ORBIT_GUI_URL": "http://gui:8765"}), patch.object(tool, "build_opener", return_value=opener):
            self.assertEqual(tool.call("act", "noop()", "fixture-id")["id"], "fixture-id")
        self.assertEqual(opener.payload, {"id": "fixture-id", "action": "noop()"})
        self.assertEqual(opener.url, "http://gui:8765/act")

    def test_screenshot_is_written_to_a_private_local_file(self):
        class Opener:
            def open(self, *_args, **_kwargs):
                return io.BytesIO(b'{"step":0,"screenshot_base64":"UE5H"}')
        with tempfile.TemporaryDirectory() as directory, patch.object(tool.tempfile, "gettempdir", return_value=directory), patch.dict(os.environ, {"ORBIT_GUI_URL": "http://gui:8765"}), patch.object(tool, "build_opener", return_value=Opener()):
            result = tool.call("observe")
            path = Path(result["screenshot"])
            self.assertEqual(path.read_bytes(), b"PNG")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertNotIn("screenshot_base64", result)

if __name__ == "__main__":
    unittest.main()
