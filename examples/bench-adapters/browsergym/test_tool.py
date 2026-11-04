"""Tool/entrypoint tests with explicit transport and filesystem fixtures, not real MCP execution."""

import importlib.util
import io
import json
import os
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import entrypoint

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

    @unittest.skipUnless(sys.version_info >= (3, 11), "MCP image entrypoint requires its Python 3.11 runtime")
    def test_mcp_setup_preserves_existing_auth_config_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"ORBIT_GUI_URL": "http://gui:8765", "CODEX_HOME": directory, "CLAUDE_CONFIG_DIR": directory}), patch.object(Path, "is_relative_to", return_value=True):
            root = Path(directory)
            (root / "config.toml").write_text('model_provider = "fixture"\n[model_providers.fixture]\nname = "fixture"\n')
            (root / ".claude.json").write_text('{"fixture":"preserve"}')
            entrypoint.configure()
            first = (root / "config.toml").read_text()
            entrypoint.configure()
            self.assertEqual((root / "config.toml").read_text(), first)
            self.assertIn('model_provider = "fixture"', first)
            self.assertEqual(json.loads((root / ".claude.json").read_text())["fixture"], "preserve")
            self.assertIn("orbit-computer", json.loads((root / ".claude.json").read_text())["mcpServers"])


if __name__ == "__main__":
    unittest.main()
