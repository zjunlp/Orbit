"""Single-threaded BrowserGym service. The Agent never mounts this service's evidence."""

import base64
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import re
import signal
import sys

from episode import Episode
from evidence import PRIVATE_KEY_FILE


class RequestError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


class Bridge:
    def __init__(self, episode):
        self.episode = episode
        self.calls = {}

    def status(self):
        e = self.episode
        return {"steps": e.result["steps"], "max_steps": e.plan["max_steps"],
                "finished": e.finished, "error": e.result.get("error_stage")}

    def observe(self):
        e = self.episode
        row = e.rows[-1]
        obs = {key: row[key] for key in
               ("step", "goal", "last_action", "last_action_error") if key in row}
        if e.plan["action_set"] == "bid":
            obs["axtree_txt"] = row.get("axtree_txt", "")
        obs.update(self.status())
        obs["screenshot_base64"] = base64.b64encode((e.output / row["screenshot"]).read_bytes()).decode()
        return obs

    def dispatch(self, method, path, body):
        e = self.episode
        if method == "GET" and path == "/status":
            return self.status()
        if method == "GET" and path == "/spec":
            height, width = e.obs["screenshot"].shape[:2]
            return {"task": e.plan["task"], "action_set": e.plan["action_set"],
                    "action_description": e.actions.describe(with_examples=True),
                    "width": width, "height": height, "max_steps": e.plan["max_steps"],
                    "observation": "screenshot + accessibility tree" if e.plan["action_set"] == "bid"
                                   else "screenshot"}
        if method == "GET" and path == "/observe":
            return self.observe()
        if method == "POST" and path == "/finish":
            try:
                e.finish()
            except Exception as exc:
                e.fail(exc)
                raise RequestError(500, f"Environment failed: {type(exc).__name__}") from None
            return self.observe()
        if method == "POST" and path == "/act":
            if not isinstance(body, dict) or set(body) != {"id", "action"}:
                raise RequestError(400, "act requires exactly id and action")
            key, action = body["id"], body["action"]
            if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", key):
                raise RequestError(400, "Invalid action id")
            if not isinstance(action, str) or not action.strip() or len(action) > 20000:
                raise RequestError(400, "Invalid action")
            if key in self.calls:
                previous, response, error = self.calls[key]
                if previous != action:
                    raise RequestError(409, "Action id was already used for a different action")
                if error:
                    raise RequestError(500, error)
                return response
            if e.finished:
                raise RequestError(409, "Episode is finished; no new actions accepted")
            try:
                e.step(action, key)
                response = dict(self.observe(), id=key)
                self.calls[key] = (action, response, None)
                return response
            except Exception as exc:
                error = f"Environment failed: {type(exc).__name__}"
                self.calls[key] = (action, None, error)
                e.fail(exc)
                raise RequestError(500, error) from None
        raise RequestError(404, "Unknown endpoint")


def handler(bridge):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def handle_request(self):
            code = 200
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 0 or length > 65536:
                    raise RequestError(413, "Request too large")
                body = json.loads(self.rfile.read(length)) if length else {}
                response = bridge.dispatch(self.command, self.path, body)
            except RequestError as exc:
                code, response = exc.status, {"error": str(exc)}
            except (ValueError, UnicodeError):
                code, response = 400, {"error": "Invalid JSON request"}
            data = json.dumps(response, ensure_ascii=False, allow_nan=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass  # The completed action stays cached even when its response was lost.

        do_GET = handle_request
        do_POST = handle_request

        def setup(self):
            super().setup()
            self.connection.settimeout(10)
    return Handler


def serve(plan, output, port=8765):
    episode = Episode(plan, output, signing_key=plan.parent / PRIVATE_KEY_FILE)
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        episode.start()
        # Playwright's synchronous API must remain on the thread that created it.
        with HTTPServer(("0.0.0.0", port), handler(Bridge(episode))) as server:
            server.timeout = 0.5
            while not stopping:
                server.handle_request()
        episode.finish()
    except Exception as exc:
        episode.fail(exc)
        print(f"BrowserGym service failed: {type(exc).__name__}", file=sys.stderr)
        return 1
    return 0 if episode.result["status"] == "completed" else 1


if __name__ == "__main__":
    sys.exit(serve(Path(sys.argv[1]), Path(sys.argv[2])))
