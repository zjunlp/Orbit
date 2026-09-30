"""Human-facing CLI and shared project-bound client for the research API."""

import argparse
import hashlib
from pathlib import Path
from typing import Any
from urllib.parse import quote

from agent_infra.gateways.cli.runs import ControllerClient


class ResearchClient:
    def __init__(self, state: Path, project_id: str, session_id: str) -> None:
        self.client = ControllerClient(state)
        binding = self.client.request(
            "research/bind", {"project_id": project_id, "session_id": session_id}
        )
        self.binding = binding["binding"]
        self.project_id = binding["project_id"]
        self.session_id = session_id

    def experiment(self, action: str, **options: Any) -> dict[str, Any]:
        """Keep MCP actions within its bound project while using the common Run API."""
        if action == "run":
            context = self.call("context")
            return self.client.request(
                "runs/command",
                options
                | {
                    "project": context["project"]["workspace"],
                    "project_id": self.project_id,
                    "session_id": self.session_id,
                },
            )
        run_id = options.pop("run_id")
        path = "runs/" + quote(run_id, safe="")
        run = self.client.request(path)
        if run["lineage"].get("project_id") != self.project_id:
            raise ValueError("Run is outside this MCP project's binding")
        if action == "status":
            return run
        if action in {"cancel", "rerun"}:
            return self.client.request(path + "/" + action, options)
        raise ValueError("unknown experiment action")

    def call(
        self, action: str, *, operation_id: str | None = None, **options: Any
    ) -> dict[str, Any]:
        result = self.client.request(
            "research/call",
            {
                "binding": self.binding,
                "action": action,
                "operation_id": operation_id,
                "options": options,
            },
        )
        if "error" in result:
            raise ValueError(f"{result['error']}: {result.get('message', '')}")
        if action == "artifact" and options.get("member") is not None and "format" in options:
            if "format" not in result:
                raise ValueError(
                    "Controller does not support artifact views; finish active experiments, "
                    "then restart Controller and MCP with the updated version"
                )
        return result


def add_research_runtime_arguments(commands: Any) -> None:
    mcp = commands.add_parser(
        "mcp", help="Project-scoped stdio MCP connected to the local Controller"
    )
    mcp.add_argument("--state-dir")
    mcp.add_argument("--project-id", required=True)
    mcp.add_argument(
        "--session-id", required=True, help="Stable identifier for this external Agent session"
    )
    parser = commands.add_parser(
        "research", help="Long-lived Docker environments and background Jobs"
    )
    actions = parser.add_subparsers(dest="action", required=True)
    for action in (
        "context",
        "open",
        "status",
        "close",
        "start",
        "stop",
        "logs",
        "read",
        "write",
        "list",
        "archive",
        "artifacts",
        "artifact",
        "events",
        "trajectory",
        "import-trace",
    ):
        item = actions.add_parser(action)
        item.add_argument("--state-dir")
        item.add_argument("--project-id", required=True)
        item.add_argument("--session-id", default="cli")
        if action in {"open", "close", "start", "stop", "write", "archive", "import-trace"}:
            item.add_argument(
                "--operation-id",
                required=True,
                help="Retry with the same ID and parameters; use a new ID for new actions",
            )
        if action not in {"open", "context"}:
            item.add_argument("run_id")
        if action == "open":
            image = item.add_mutually_exclusive_group(required=True)
            image.add_argument("--image", help="Existing Python 3 image (legacy path)")
            image.add_argument(
                "--environment-lock", help="Validated environment plan_id:attempt_id"
            )
            item.add_argument("--cpu", type=float, default=1)
            item.add_argument("--memory-gib", type=float, default=2)
        if action == "start":
            item.add_argument("--cwd", default=".")
            item.add_argument("--timeout", type=float, default=3600)
            item.add_argument(
                "--argv",
                nargs=argparse.REMAINDER,
                required=True,
                help="Put --argv last, followed by the command and its flags",
            )
        if action in {"stop", "logs"}:
            item.add_argument("job_id")
        if action == "logs":
            item.add_argument("--cursor", type=int, default=0)
        if action in {"read", "write", "list", "archive"}:
            item.add_argument("path", help="Relative container workspace path")
        if action == "read":
            item.add_argument("--offset", type=int, default=0)
        if action in {"write", "import-trace"}:
            item.add_argument("--file", type=Path, required=True, help="Explicit local source file")
        if action == "import-trace":
            item.add_argument("--provider", choices=("codex", "claude-code", "dsh"), required=True)
        if action == "artifact":
            item.add_argument("artifact_id")
            item.add_argument("--member")
            item.add_argument(
                "--format", choices=("auto", "text", "base64", "metadata"), default="auto"
            )
            item.add_argument("--offset", type=int, default=0, help="Byte offset; use next_offset")
            item.add_argument("--limit", type=int, default=16384, help="Page bytes, 4–65536")
        if action == "events":
            item.add_argument("--cursor")


def research_client(state: Path, args: argparse.Namespace) -> dict[str, Any]:
    client = ResearchClient(state, args.project_id, args.session_id)
    options = {
        k: v
        for k, v in vars(args).items()
        if k
        not in {
            "command",
            "action",
            "state_dir",
            "project_id",
            "session_id",
            "operation_id",
            "file",
        }
        and v is not None
    }
    if args.action == "open":
        options["memory_bytes"] = int(options.pop("memory_gib") * 1024**3)
    if args.action == "start":
        options["timeout_seconds"] = options.pop("timeout")
    if args.action == "write":
        if args.file.stat().st_size > 32768:
            raise ValueError("write source exceeds 32 KiB")
        options["text"] = args.file.read_text()
    if args.action == "import-trace":
        if args.file.stat().st_size > 16 * 1024**2:
            raise ValueError("explicit trace import exceeds 16 MiB")
        data = args.file.read_bytes()
        source_id = hashlib.sha256(data).hexdigest()
        # Preserve native line identity across chunks and retries.
        count = 0
        for offset, line in enumerate(data.decode().splitlines()):
            result = client.call(
                "import_trace",
                operation_id=f"{args.operation_id}:{offset}",
                **options,
                source_id=source_id,
                line_offset=offset,
                text=line,
            )
            count += result["decoded_events"]
        return {"source_id": source_id, "decoded_events": count, "capture_status": "partial"}
    return client.call(args.action, operation_id=getattr(args, "operation_id", None), **options)
