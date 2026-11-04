"""One episode, HTTP action-id deduplication and signed evidence shared by GUI backends."""

import base64
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import re
import shutil
import signal
import sys
import time

from .evidence import PRIVATE_KEY_FILE, digest, read, trajectory_review, write, sign_result


def capture(output, obs, step, action, reward, terminated, truncated, info, action_id=None):
    path = f"screenshots/{step:04d}.png"
    if not isinstance(obs["screenshot"], bytes):
        raise TypeError("Backend screenshot must be PNG bytes")
    (output / path).write_bytes(obs["screenshot"])
    row = {k: obs[k] for k in ("goal", "last_action", "last_action_error", "text", "axtree_txt", "frame_source") if k in obs}
    row.update(step=step, action=action, reward=reward, terminated=bool(terminated),
               truncated=bool(truncated), task_info=info.get("task_info", {}), screenshot=path)
    if action_id is not None:
        row.update(action_id=action_id, at=datetime.now(timezone.utc).isoformat())
    with (output / "trajectory.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n")
        stream.flush()
    with (output / "trajectory.md").open("a", encoding="utf-8") as stream:
        stream.write(f"\n## Step {step} · reward {reward}\n\n")
        if action is not None:
            stream.write("    " + action.replace("\n", "\n    ") + "\n\n")
        stream.write(f"![Observation {step}]({path})\n")
    return row


class Episode:
    def __init__(self, plan_path, output, backend, signing_key=None):
        self.output = Path(output)
        self.signing_key = signing_key
        self.plan = read(plan_path)
        self.backend = backend
        self.result = {"status": "error", "steps": 0}
        self.phase = "environment_setup"
        self.policy = None
        self.rows = []
        self.started = time.monotonic()
        self.finished = False
        self.output.mkdir(parents=True, exist_ok=True)
        (self.output / "screenshots").mkdir(exist_ok=True)
        shutil.copyfile(plan_path, self.output / "plan.json")

    def start(self):
        self.obs = self.backend.reset()
        self.result.update(getattr(self.backend, "details", {}))
        (self.output / "trajectory.md").write_text(
            f"# {self.plan['task']} · seed {self.plan['seed']}\n\n"
            "Reward is computed by the original live environment.\n\n"
            + "    " + self.obs["goal"].replace("\n", "\n    ") + "\n", encoding="utf-8")
        self.rows.append(capture(self.output, self.obs, 0, None, 0, False, False, getattr(self.backend, "reset_info", {})))

    def step(self, action, action_id=None, final_reason=None):
        if self.finished or self.result["steps"] >= self.plan["max_steps"]:
            raise ValueError("Episode is finished")
        if not isinstance(action, str) or not action.strip():
            raise TypeError("Policy must return an action string or None to stop")
        self.phase = "environment_step"
        self.obs, reward, terminated, truncated, info = self.backend.step(action)
        self.phase = "capture"
        step = self.result["steps"] + 1
        self.rows.append(capture(self.output, self.obs, step,
                                 action, reward, terminated, truncated, info, action_id))
        self.result.update(steps=step, reward=reward)
        reason = ("terminated" if terminated or truncated else
                  final_reason or ("max_steps" if step == self.plan["max_steps"] else None))
        if reason:
            self.finish(reason, stepped=True)
        return self.rows[-1]

    def fail(self, exc, phase=None):
        self.result.update(status="error", error_type=type(exc).__name__,
                           error_stage=phase or self.phase)
        self.finish(error=True)
        self.persist()

    def finish(self, reason="agent_stop", error=False, stepped=False):
        if self.finished:
            return self.result
        if not error and not stepped and reason in ("empty", "agent_stop"):
            # The backend supplies its original stop action.
            if not self.rows or self.result["steps"] >= self.plan["max_steps"]:
                raise ValueError("Cannot finish an uninitialized/exhausted episode")
            self.step(self.backend.spec()["stop_action"], final_reason=reason)
            if self.finished:
                return self.result
        self.finished = True
        if not error:
            self.result.update(status="completed", stop_reason=reason)
        for obj in (self.policy, self.backend):
            try:
                if obj is not None and callable(getattr(obj, "close", None)):
                    obj.close()
            except Exception as exc:
                self.result.update(status="error", error_type=type(exc).__name__, error_stage="cleanup")
        self.result["elapsed_sec"] = time.monotonic() - self.started
        self.persist()
        return self.result

    def persist(self):
        if self.rows:
            write(self.output / "trajectory-review.json", trajectory_review(self.rows, self.result, self.plan.get("review_prefix", "")))
        paths = [self.output / "plan.json", self.output / "trajectory.jsonl",
                 *sorted((self.output / "screenshots").glob("*.png"))]
        if (self.output / "trajectory-review.json").is_file():
            paths.append(self.output / "trajectory-review.json")
        self.result["sha256"] = {str(p.relative_to(self.output)): digest(p) for p in paths if p.is_file()}
        write(self.output / "result.json", self.result)
        if self.signing_key is not None:
            sign_result(self.output, self.signing_key)


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
        if e.backend.spec().get("action_set") == "bid":
            obs["axtree_txt"] = row.get("axtree_txt", "")
        obs.update(self.status())
        obs["screenshot_base64"] = base64.b64encode((e.output / row["screenshot"]).read_bytes()).decode()
        return obs

    def dispatch(self, method, path, body):
        e = self.episode
        if method == "GET" and path == "/status":
            return self.status()
        if method == "GET" and path == "/spec":
            return {"task": e.plan["task"], "max_steps": e.plan["max_steps"], **e.backend.spec()}
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
            except RequestError:
                raise
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


def serve(plan, output, backend, port=8765):
    episode = Episode(plan, output, backend, signing_key=plan.parent / PRIVATE_KEY_FILE)
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
        print(f"GUI service failed: {type(exc).__name__}", file=sys.stderr)
        return 1
    return 0 if episode.result["status"] == "completed" else 1
