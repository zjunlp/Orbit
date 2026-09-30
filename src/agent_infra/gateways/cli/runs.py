"""Run command arguments and loopback-only client. No scheduling or Docker access."""

import argparse
import base64
import json
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import ProxyHandler, Request, build_opener
from uuid import uuid4


def add_run_arguments(commands: Any) -> None:
    controller = commands.add_parser(
        "controller", help="Run the persistent local execution service"
    )
    controls = controller.add_subparsers(dest="action", required=True)
    serve = controls.add_parser(
        "serve", help="Foreground daemon; keep running while submitting from another terminal"
    )
    serve.add_argument("--state-dir")
    serve.add_argument("--port", type=int, default=8766)
    serve.add_argument(
        "--model-proxy", default="auto", help="auto (host HTTPS_PROXY), direct, or http://host:port"
    )
    serve.add_argument("--cpu", type=float, default=1, help="Authorized total CPU cores")
    serve.add_argument("--memory-gib", type=float, default=2, help="Authorized total memory")
    serve.add_argument(
        "--gpu-uuid",
        action="append",
        default=[],
        help="Authorize one observed NVIDIA GPU UUID; repeat for multiple devices",
    )
    run = commands.add_parser("run", help="Preflight, submit and inspect persistent runs")
    actions = run.add_subparsers(dest="action", required=True)
    command = actions.add_parser(
        "command", help="Snapshot an existing workspace and run a Docker command"
    )
    command.add_argument("--state-dir")
    command.add_argument("--project", type=Path, default=Path.cwd())
    command.add_argument("--project-id")
    command.add_argument("--name", default="Experiment")
    command.add_argument("--image", required=True)
    command.add_argument("--cpu", type=float, default=1)
    command.add_argument("--memory-gib", type=float, default=2)
    command.add_argument("--gpu-uuid", action="append", default=[])
    command.add_argument("--mount", action="append", default=[], metavar="SOURCE:/inputs/NAME")
    command.add_argument("--output", action="append", dest="outputs")
    command.add_argument("--cwd", default=".")
    command.add_argument("--timeout", type=float, default=3600)
    command.add_argument("--network", action="store_true")
    command.add_argument("--operation-id")
    command.add_argument("--session-id")
    command.add_argument("--provider")
    command.add_argument("--wait", action="store_true")
    command.add_argument("argv", nargs=argparse.REMAINDER, help="-- executable arguments...")
    for name in ("rerun", "wait"):
        item = actions.add_parser(name)
        item.add_argument("run_id")
        item.add_argument("--state-dir")
        if name == "rerun":
            item.add_argument("--operation-id")
    for name in (
        "preflight",
        "submit",
        "status",
        "cancel",
        "list",
        "events",
        "trajectory",
        "artifacts",
        "artifact",
    ):
        parser = actions.add_parser(name)
        parser.add_argument("--state-dir")
        if name in {"preflight", "submit"}:
            parser.add_argument("task_id")
            parser.add_argument("--task-revision", required=True)
            parser.add_argument("--provider", default="codex")
            parser.add_argument(
                "--model", required=True, help="Explicit model selection for this run"
            )
            parser.add_argument("--reasoning-effort")
            parser.add_argument("--timeout", type=float, default=600)
            parser.add_argument("--network", action="store_true", help="Allow model network access")
            if name == "submit":
                parser.add_argument(
                    "--operation-id",
                    required=True,
                    help="Reuse this key only for retries; change it for a new run",
                )
        elif name == "list":
            parser.add_argument("--project-id")
            parser.add_argument("--limit", type=int, default=100)
            parser.add_argument("--offset", type=int, default=0)
        else:
            parser.add_argument("run_id")
            if name == "events":
                parser.add_argument("--cursor")
            if name == "artifact":
                parser.add_argument("artifact_id")
                parser.add_argument("--member", help="Exact file path from the artifact manifest")
                parser.add_argument(
                    "--output", type=Path, help="Save one member locally without overwriting"
                )


class ControllerClient:
    def __init__(self, state: Path) -> None:
        try:
            endpoint = json.loads((state / "controller/endpoint.json").read_text())
            self.port = int(endpoint["port"])
            self.token = str(endpoint["token"])
        except (OSError, ValueError, KeyError) as error:
            raise ValueError(
                "controller not configured; start agent-infra controller serve "
                "with the same --state-dir"
            ) from error
        if not 1 <= self.port <= 65535 or len(self.token) < 32:
            raise ValueError("invalid controller endpoint")

    def request(
        self, path: str, body: dict[str, Any] | None = None, *, timeout: float = 120
    ) -> dict[str, Any]:
        request = Request(
            f"http://127.0.0.1:{self.port}/api/v1/" + path,
            data=json.dumps(body, ensure_ascii=False).encode() if body is not None else None,
            headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"},
        )
        try:
            with build_opener(ProxyHandler({})).open(request, timeout=timeout) as response:
                return dict(json.load(response))
        except HTTPError as error:
            detail = json.load(error)
            raise ValueError(
                f"{detail.get('error')}: {detail.get('message', 'request rejected')}"
            ) from error
        except URLError as error:
            raise ValueError(
                "controller unavailable; start controller serve with the same --state-dir"
            ) from error


def run_client(state: Path, args: argparse.Namespace) -> dict[str, Any]:
    client = ControllerClient(state)
    action = args.action
    if action == "command":
        mounts = []
        for value in args.mount:
            source, separator, target = value.partition(":/inputs/")
            if not separator:
                raise ValueError("mount format: /host/dataset:/inputs/name (read-only)")
            mounts.append({"source": str(Path(source).resolve()), "target": "/inputs/" + target})
        argv = args.argv[1:] if args.argv[:1] == ["--"] else args.argv
        result = client.request(
            "runs/command",
            {
                "project": str(args.project.resolve()),
                "project_id": args.project_id,
                "name": args.name,
                "image": args.image,
                "argv": argv,
                "cwd": args.cwd,
                "cpu_cores": args.cpu,
                "memory_bytes": int(args.memory_gib * 1024**3),
                "gpu_device_ids": args.gpu_uuid,
                "mounts": mounts,
                "outputs": args.outputs or ["outputs"],
                "timeout_seconds": args.timeout,
                "network": args.network,
                "session_id": args.session_id,
                "provider": args.provider,
                "operation_id": args.operation_id or str(uuid4()),
            },
        )
        return _wait(client, result["run_id"]) if args.wait else result
    if action == "rerun":
        return client.request(
            "runs/" + quote(args.run_id, safe="") + "/rerun",
            {"operation_id": args.operation_id or str(uuid4())},
        )
    if action == "wait":
        return _wait(client, args.run_id)
    if action in {"submit", "preflight"}:
        body = {
            "task_id": args.task_id,
            "task_revision": args.task_revision,
            "provider": args.provider,
            "model": args.model,
            "reasoning_effort": args.reasoning_effort,
            "timeout_seconds": args.timeout,
            "network": args.network,
        }
        if action == "submit":
            body["operation_id"] = args.operation_id
        return client.request("runs" + ("/preflight" if action == "preflight" else ""), body)
    if action == "list":
        return client.request(
            "runs?"
            + urlencode(
                {
                    key: getattr(args, key)
                    for key in ("project_id", "limit", "offset")
                    if getattr(args, key) is not None
                }
            )
        )
    path = "runs/" + quote(args.run_id, safe="")
    if action == "cancel":
        return client.request(path + "/cancel", {})
    if action == "status":
        return client.request(path)
    if action == "artifact":
        path += "/artifacts/" + quote(args.artifact_id, safe="")
        if args.member:
            path += "?" + urlencode({"member": args.member})
        result = client.request(path)
        if args.output:
            if not args.member:
                raise ValueError("--output requires --member")
            with args.output.open("xb") as file:
                file.write(base64.b64decode(result.pop("content_base64"), validate=True))
            result["saved_to"] = str(args.output)
        return result
    path += "/" + action
    if action == "events" and args.cursor:
        path += "?" + urlencode({"cursor": args.cursor})
    return client.request(path)


def _wait(client: ControllerClient, run_id: str) -> dict[str, Any]:
    while True:
        result = client.request("runs/" + quote(run_id, safe=""))
        if result["state"] in {"finished", "quarantined"}:
            return result
        time.sleep(1)
