"""Exercise the actual shared Unix HTTP transport without native benchmark dependencies."""

from http.server import BaseHTTPRequestHandler
import json
from pathlib import Path
from socketserver import UnixStreamServer
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk"))
from orbit_bench import tool_socket


class TransportTest(unittest.TestCase):
    def test_get_post_and_http_failure(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                if self.path == "/missing":
                    self.send_error(404)
                    return
                self.reply({"prompt": "Native task"})

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                self.reply({"received": payload})

            def reply(self, value):
                raw = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        with tempfile.TemporaryDirectory() as directory:
            with patch.object(tool_socket, "SOCKET", str(Path(directory) / "tools.sock")):
                with UnixStreamServer(tool_socket.SOCKET, Handler) as server:
                    thread = threading.Thread(target=server.serve_forever)
                    thread.start()
                    try:
                        self.assertEqual(tool_socket.request("info"), {"prompt": "Native task"})
                        value = {"code": "print('hello')", "argument": "Unicode: \u03b1"}
                        self.assertEqual(tool_socket.request("execute", value), {"received": value})
                        with self.assertRaisesRegex(RuntimeError, "HTTP 404"):
                            tool_socket.request("missing")
                    finally:
                        server.shutdown()
                        thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
