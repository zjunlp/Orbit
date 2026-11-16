"""Private AgentDojo tool service; fresh native replay checks its collected trace."""

from http.server import BaseHTTPRequestHandler
import json
import os
from pathlib import Path
import sys


def environment(item):
    from agentdojo.task_suite.load_suites import get_suite
    from agentdojo.functions_runtime import FunctionsRuntime
    suite_name, task_id = item["task"].split("/")
    suite = get_suite(item["version"], suite_name)
    task = suite.get_user_task_by_id(task_id)
    env = task.init_environment(suite.load_and_inject_default_environment({}))
    return suite, task, env, FunctionsRuntime(suite.tools)


def serve(item):
    from agentdojo.functions_runtime import FunctionCall
    from tool_socket import serve as serve_socket
    suite, task, env, runtime = environment(item)
    trace = {"task": item["task"], "revision": item["revision"], "calls": [], "answer": "", "finished": False}
    dest = Path("/evidence/trace.json")
    dest.parent.mkdir(exist_ok=True)

    def save():
        temporary = dest.with_suffix(".tmp")
        temporary.write_text(json.dumps(trace))
        temporary.replace(dest)

    def call(data):
        if trace["finished"] or len(trace["calls"]) >= item["maxCalls"]:
            raise ValueError("Task finished or call budget exhausted")
        request = FunctionCall.model_validate(data)
        result, error = runtime.run_function(env, request.function, request.args)
        trace["calls"].append(request.model_dump())
        save()
        return {"result": result, "error": error}

    save()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            if self.path != "/info":
                self.send_error(404)
                return
            self.reply({"prompt": task.PROMPT,
                        "tools": [{"name": f.name, "description": f.description,
                                   "parameters": f.parameters.model_json_schema()} for f in runtime.functions.values()]})

        def reply(self, data):
            raw = json.dumps(data, default=str).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self):
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 1024 * 1024:
                    raise ValueError("Invalid request length")
                data = json.loads(self.rfile.read(length))
                if self.path == "/call":
                    self.reply(call(data))
                elif self.path == "/finish":
                    if trace["finished"] or not isinstance(data.get("answer"), str):
                        raise ValueError("Already finished or invalid answer")
                    trace.update({"answer": data["answer"], "finished": True})
                    save()
                    self.reply({"finished": True})
                elif self.path == "/baseline" and item["mode"] in ("oracle", "empty") and data.get("mode") == item["mode"]:
                    if trace["finished"]:
                        raise ValueError("Already finished")
                    if item["mode"] == "oracle":
                        for request in task.ground_truth(env):
                            call(request.model_dump())
                    trace.update({"answer": task.GROUND_TRUTH_OUTPUT if item["mode"] == "oracle" else "", "finished": True})
                    save()
                    self.reply({"finished": True})
                else:
                    self.send_error(404)
            except (ValueError, TypeError, KeyError) as exc:
                self.reply({"error": str(exc)})

    serve_socket(Handler)


def verify(item, solve_dir="/solve", output=None):
    from agentdojo.functions_runtime import FunctionCall
    from agentdojo.types import text_content_block_from_string
    result = {"task": item["task"]}
    try:
        path = Path(solve_dir) / "services/tools/evidence/trace.json"
        trace = json.loads(path.read_text())
        if trace["task"] != item["task"] or trace["revision"] != item["revision"]:
            raise ValueError("Service trace identity mismatch")
        suite, task, env, runtime = environment(item)
        before = env.model_copy(deep=True)
        calls = [FunctionCall.model_validate(call) for call in trace["calls"]]
        if len(calls) > item["maxCalls"]:
            raise ValueError("Tool trace exceeds budget")
        for call in calls:
            runtime.run_function(env, call.function, call.args)
        utility = suite._check_user_task_utility(task, [text_content_block_from_string(trace["answer"])], before, env, calls)
        result.update({"utility": bool(utility), "calls": len(calls), "finished": trace["finished"]})
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
    dest = Path(output or os.environ["ORBIT_OUTPUT"])
    (dest / "result.json").write_text(json.dumps(result))


def baseline(item, output=None):
    _, task, env, runtime = environment(item)
    calls = task.ground_truth(env) if item["mode"] == "oracle" else []
    for call in calls:
        runtime.run_function(env, call.function, call.args, raise_on_error=True)
    trace = {"task": item["task"], "revision": item["revision"],
             "calls": [call.model_dump() for call in calls],
             "answer": task.GROUND_TRUTH_OUTPUT if item["mode"] == "oracle" else "", "finished": True}
    dest = Path(output or os.environ["ORBIT_OUTPUT"]) / "services/tools/evidence/trace.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(trace))


if __name__ == "__main__":
    item = json.loads(Path("/input/task.json").read_text())
    if sys.argv[1] == "serve":
        serve(item)
    elif sys.argv[1] == "baseline":
        baseline(item)
    else:
        verify(item)
