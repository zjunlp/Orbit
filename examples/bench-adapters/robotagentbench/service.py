"""Private native worker transport; no model API or Agent loop."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib
import json
import os
from pathlib import Path
import sys
import threading
import urllib.request

ROOT = Path("/evidence")
PLAN = Path("/adapter/plan.json")


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2))


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


class RobotService:
    def __init__(self, bridge, plan):
        self.bridge, self.plan = bridge, plan
        self.lock = threading.RLock()
        self.gate = threading.Lock()
        self.closed = False
        self.finalized = False

    def call(self, name, arguments, call_id):
        with self.gate:
            if self.closed:
                raise RuntimeError("The native episode is closing")
        with self.lock:
            with self.gate:
                if self.closed:
                    raise RuntimeError("The native episode is closing")
            value = self.bridge.dispatch(call_id, name, arguments)
            if name == "observe":
                value["contentItems"].insert(0, {"type": "inputText", "text": self.bridge.instructions.replace("You have 1000000 model turns.", "Orbit controls the Agent session budget.")})
            return value

    def initial(self):
        with self.lock:
            return {"contract": self.bridge.contract, "observation": self.bridge.observed,
                    "completed": self.bridge.completed}

    def finalize(self):
        from evidence_helpers import sign_result
        with self.gate:
            self.closed = True
        with self.lock:
            if self.finalized:
                return
            result = {"version": 1, "plan": self.plan, "valid": False,
                      "completed": self.bridge.completed, "abandoned": self.bridge.abandoned}
            try:
                closure = self.bridge.close()
                from robotagentbench.model_examples.native_receipts import collect, verify
                receipts = collect("room", self.plan["nativeOutput"])
                accepted = verify("room", self.plan["nativeTask"], self.bridge.observed["episode_id"],
                    receipts, closed_ack=closure["closed_ack"],
                    worker_exit_code=closure["transport_exit_code"])
                result.update(valid=accepted, closure=closure, receipts=receipts,
                    ownerResult=self.bridge.owner_result, episode=self.bridge.observed["episode_id"])
            except Exception as exc:
                result["error"] = type(exc).__name__ + ": " + str(exc)
            result["sha256"] = {p.relative_to(ROOT).as_posix(): sha(p)
                for p in sorted(ROOT.rglob("*")) if p.is_file()
                and p.relative_to(ROOT).as_posix() not in ("result.json", "evidence-signature.json")}
            write(ROOT / "result.json", result)
            sign_result(ROOT, "/adapter/private.pem")
            self.finalized = True


def make_handler(service):
    from robotagentbench.model_examples.codex.raw_bridge import tool_specs
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            return

        def reply(self, code, value):
            raw = json.dumps(value, allow_nan=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if self.path == "/ready":
                self.reply(200, {"ready": not service.closed})
            elif self.path == "/tools":
                self.reply(200, tool_specs())
            elif self.path == "/initial":
                self.reply(200, service.initial())
            else:
                self.reply(404, {"error": "Unknown public endpoint"})

        def do_POST(self):
            if self.path == "/private/finalize":
                if self.client_address[0] != "127.0.0.1":
                    self.reply(403, {"error": "Lifecycle is private to the service"})
                    return
                service.finalize()
                self.reply(200, {"finalized": service.finalized})
                return
            if self.path != "/call":
                self.reply(404, {"error": "Unknown public endpoint"})
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 4 * 1024 * 1024:
                    raise ValueError("Invalid request size")
                row = json.loads(self.rfile.read(size))
                if set(row) != {"name", "arguments", "id"}:
                    raise ValueError("Invalid call fields")
                value = service.call(row["name"], row["arguments"], row["id"])
                self.reply(200, value)
            except Exception as exc:
                write(ROOT / "transport-error.json", {"error": type(exc).__name__})
                self.reply(400, {"error": "Native operation failed; no automatic retry is allowed"})
    return Handler


def serve():
    from robotagentbench.model_examples.codex.protocol import Worker
    from robotagentbench.model_examples.codex.raw_bridge import RawRobotBridge
    package = importlib.import_module("robotagentbench")
    package_root = Path(package.__file__).parent
    plan = json.loads(PLAN.read_text())
    ROOT.mkdir(parents=True, exist_ok=True)
    if os.geteuid() == 0:
        os.chown(ROOT, plan["uid"], plan["gid"])
        os.setgroups([])
        os.setgid(plan["gid"])
        os.setuid(plan["uid"])
    Path.home().mkdir(parents=True, exist_ok=True)
    for name, expected in plan["runtimeFiles"].items():
        if sha(package_root / name) != expected:
            raise ValueError("Native image package differs from the pinned source")
    from robotagentbench.simulation.native_deployment import validate, verify_image_baseline
    deployment = plan["deployment"]
    prepared = validate(Path(plan["runtime"]), deployment["name"], image=deployment["image"], sdk_site="/opt/robotagentbench/native")
    if verify_image_baseline(sdk_site="/opt/robotagentbench/native", check_visible_sdk=True) != json.loads((prepared["root"] / "image_baseline.json").read_text()):
        raise ValueError("Native deployment SDK baseline changed")
    ROOT.mkdir(parents=True, exist_ok=True)
    with (ROOT / "worker-stderr.log").open("w") as stderr:
        worker = Worker(plan["command"], stderr, timeout=900)
        bridge = RawRobotBridge(worker, ROOT / "observations", max_model_responses=1000000)
        service = RobotService(bridge, plan)
        server = ThreadingHTTPServer(("0.0.0.0", 8765), make_handler(service))
        try:
            server.serve_forever()
        finally:
            service.finalize()
            server.server_close()


def main():
    if sys.argv[1] == "serve":
        serve()
        return
    path = "/ready" if sys.argv[1] == "ready" else "/private/finalize"
    request = urllib.request.Request("http://127.0.0.1:8765" + path,
                                    data=None if path == "/ready" else b"{}")
    with urllib.request.urlopen(request, timeout=590) as response:
        response.read()


if __name__ == "__main__":
    main()
