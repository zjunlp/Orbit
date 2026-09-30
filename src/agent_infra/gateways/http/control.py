"""Authenticated loopback transport for the local Run controller (no filesystem routes)."""

import hmac
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, cast
from urllib.parse import parse_qs, unquote, urlsplit

from agent_infra.runs.command_api import CommandRequest
from agent_infra.runs.commands import CommandRuns
from agent_infra.runs.control_api import ControlError, SubmissionRequest
from agent_infra.runs.controller import LocalRunController
from agent_infra.runs.planner import PlannerSessions
from agent_infra.runs.query import RunQueries
from agent_infra.runs.research import ResearchController


def create_control_server(
    controller: LocalRunController,
    queries: RunQueries,
    token: str,
    port: int = 8766,
    *,
    research: ResearchController | None = None,
    planner: PlannerSessions | None = None,
    commands: CommandRuns | None = None,
) -> ThreadingHTTPServer:
    if len(token) < 32:
        raise ValueError("controller token must contain at least 32 characters")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            pass

        def do_GET(self) -> None:
            self.dispatch("GET")

        def do_POST(self) -> None:
            self.dispatch("POST")

        def respond(self, status: int, value: object) -> None:
            data = json.dumps(value, default=str, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        def dispatch(self, method: str) -> None:
            port = cast(ThreadingHTTPServer, self.server).server_port
            if self.headers.get("Host") not in {f"127.0.0.1:{port}", f"localhost:{port}"}:
                self.respond(403, {"error": "host_not_allowed"})
                return
            if not hmac.compare_digest(
                self.headers.get("Authorization", "").encode(), ("Bearer " + token).encode()
            ):
                self.respond(401, {"error": "unauthorized"})
                return
            try:
                body: dict[str, Any] = {}
                if method == "POST":
                    size = int(self.headers.get("Content-Length", "0"))
                    if (
                        self.headers.get_content_type() != "application/json"
                        or not 0 < size <= 65536
                    ):
                        raise ValueError("expected JSON body up to 64 KiB")
                    body = json.loads(self.rfile.read(size))
                    if not isinstance(body, dict):
                        raise ValueError("expected JSON object")
                result = self.route(method, body)
                self.respond(200, result)
            except ControlError as error:
                self.respond(409, {"error": error.code, "message": str(error)})
            except KeyError:
                self.respond(404, {"error": "not_found"})
            except (ValueError, TypeError) as error:
                self.respond(400, {"error": "invalid_request", "message": str(error)})
            except Exception:
                self.respond(
                    503,
                    {
                        "error": "unavailable",
                        "message": "check controller, Docker and state directory",
                    },
                )

        def route(self, method: str, body: dict[str, Any]) -> object:
            parsed = urlsplit(self.path)
            parts = [unquote(part) for part in parsed.path.strip("/").split("/")]
            query = parse_qs(parsed.query)
            if parts[:2] != ["api", "v1"]:
                raise KeyError(self.path)
            if parts[2:] == ["runs", "command"] and method == "POST" and commands is not None:
                operation = body.pop("operation_id", None)
                return commands.submit(operation, CommandRequest.model_validate(body))
            if method == "POST" and planner is not None and parts[2:3] == ["planner"]:
                if parts[3:] == ["start"]:
                    return planner.start(body["project_id"], body["options"], body["operation_id"])
                run_id = body["options"]["run_id"]
                run = controller.store.get(run_id)
                if (
                    run["lineage"].get("project_id") != body["project_id"]
                    or run["request"].get("kind") != "planner"
                ):
                    raise KeyError(run_id)
                if parts[3:] == ["stop"]:
                    return planner.stop(run_id)
                if parts[3:] == ["status"]:
                    return queries.status(run_id)
                raise KeyError(self.path)
            if method == "POST" and research is not None:
                if parts[2:] == ["research", "bind"]:
                    return research.bind(body["project_id"], body["session_id"])
                if parts[2:] == ["research", "call"]:
                    return research.call(
                        body["binding"],
                        body["action"],
                        body.get("options", {}),
                        body.get("operation_id"),
                    )
            if parts[2:] == ["health"] and method == "GET":
                return {
                    "ready": not controller.quarantined and not controller.closed,
                    "single_active_run": commands is None,
                    "queued_commands": commands is not None,
                    "frozen_task_slots": 1,
                }
            if parts[2:] == ["runs", "preflight"] and method == "POST":
                return controller.preflight(SubmissionRequest.from_dict(body))
            if parts[2:] == ["runs"]:
                if method == "POST":
                    operation = body.pop("operation_id", None)
                    return controller.submit(operation, SubmissionRequest.from_dict(body))
                return {
                    "items": controller.store.list_runs(
                        project_id=query.get("project_id", [None])[0],
                        limit=int(query.get("limit", ["100"])[0]),
                        offset=int(query.get("offset", ["0"])[0]),
                    )
                }
            if len(parts) >= 4 and parts[2] == "runs":
                run_id = parts[3]
                if commands is not None and method == "POST":
                    if parts[4:] == ["rerun"]:
                        return commands.rerun(run_id, body["operation_id"])
                    if (
                        parts[4:] == ["cancel"]
                        and controller.store.get(run_id)["request"].get("kind") == "command"
                    ):
                        return commands.service.status(run_id, cancel=True)
                if parts[4:] == ["cancel"] and method == "POST":
                    return controller.cancel(run_id)
                if method != "GET":
                    raise KeyError(self.path)
                if len(parts) == 4:
                    return queries.status(run_id)
                if parts[4:] == ["events"]:
                    return queries.events(run_id, query.get("cursor", [None])[0])
                if parts[4:] == ["trajectory"]:
                    return queries.trajectory(run_id)
                if parts[4:] == ["artifacts"]:
                    return {"items": queries.artifacts(run_id)}
                if len(parts) == 6 and parts[4] == "artifacts":
                    return queries.artifact(run_id, parts[5], query.get("member", [None])[0])
            raise KeyError(self.path)

    class Server(ThreadingHTTPServer):
        daemon_threads = True

        def get_request(self) -> Any:
            connection, address = super().get_request()
            connection.settimeout(15)
            return connection, address

    return Server(("127.0.0.1", port), Handler)
