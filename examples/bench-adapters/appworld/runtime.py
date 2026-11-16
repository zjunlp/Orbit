"""AppWorld native execution with service-owned evidence and independent replay."""

from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import sys


def environment(item, full=False):
    from appworld import AppWorld
    from appworld.common.path_store import path_store
    root = Path("/tmp/orbit-appworld")
    root.mkdir(exist_ok=True)
    (root / "data").symlink_to("/data", target_is_directory=True)
    path_store.update_root(str(root))
    return AppWorld(task_id=item["task"], experiment_name="orbit", load_ground_truth=full,
                    ground_truth_mode="full" if full else "minimal", raise_on_failure=False)


def save_trace(item, codes, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"task": item["task"], "source": item["source"], "codes": codes}))
    temporary.replace(path)


def baseline(item, out):
    codes = []
    if item["mode"] == "oracle":
        with environment(item, full=True) as world:
            code = world.task.ground_truth.compiled_solution_code
            if not code.strip():
                raise ValueError("No original compiled reference solution is available")
            code += "\nsolution(apis, requester)"
            world.execute(code)
            codes.append(code)
    save_trace(item, codes, out / "services/tools/evidence/trace.json")


def serve(item):
    codes = []
    path = Path("/evidence/trace.json")
    world = environment(item)
    save_trace(item, codes, path)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, value):
            raw = json.dumps(value, default=str).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if self.path != "/info":
                self.send_error(404)
                return
            self.reply({"instruction": world.task.instruction, "supervisor": dict(world.task.supervisor),
                        "datetime": str(world.task.datetime), "apps": world.task.app_descriptions,
                        "api_docs": world.task.api_docs, "maxInteractions": item["maxInteractions"]})

        def do_POST(self):
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if self.path != "/execute" or not 0 < size <= 1024 * 1024:
                    raise ValueError("Invalid execution request")
                code = json.loads(self.rfile.read(size))["code"]
                if not isinstance(code, str) or len(codes) >= item["maxInteractions"]:
                    raise ValueError("Invalid code or interaction budget exhausted")
                # AppWorld's own syntax guard and execution timeouts remain enabled.
                response = world.execute(code)
                codes.append(code)
                save_trace(item, codes, path)
                self.reply({"output": response})
            except (ValueError, TypeError, KeyError) as exc:
                self.reply({"error": str(exc)})

    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()


def verify(item, solve, out):
    result = {"task": item["task"]}
    try:
        trace = json.loads((solve / "services/tools/evidence/trace.json").read_text())
        if trace["task"] != item["task"] or trace["source"] != item["source"]:
            raise ValueError("Service trace identity mismatch")
        codes = trace["codes"]
        if not isinstance(codes, list) or len(codes) > item["maxInteractions"] or any(not isinstance(c, str) for c in codes):
            raise ValueError("Invalid native interaction trace")
        with environment(item, full=True) as world:
            for code in codes:
                world.execute(code)
            tracker = world.evaluate()
            result.update({"success": bool(tracker.success), "native": tracker.to_dict(), "interactions": len(codes)})
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
    (out / "result.json").write_text(json.dumps(result, indent=2, default=str) + "\n")


if __name__ == "__main__":
    item = json.loads(Path("/input/task.json").read_text())
    mode = sys.argv[1]
    out = Path(os.environ.get("ORBIT_OUTPUT", "/tmp"))
    if mode == "serve":
        serve(item)
    elif mode == "baseline":
        baseline(item, out)
    else:
        verify(item, Path("/solve"), out)
