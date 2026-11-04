#!/usr/bin/env python3
"""BrowserGym bridge client: standard-library CLI, plus optional MCP stdio transport."""

import argparse
import base64
import json
import os
from pathlib import Path
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener
import uuid


def call(operation, action=None, action_id=None):
    url = os.environ.get("ORBIT_GUI_URL", "")
    parsed = urlsplit(url)
    if parsed.scheme != "http" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("ORBIT_GUI_URL must be the Run's private HTTP environment URL")
    payload = ({"action": action, "id": action_id or str(uuid.uuid4())} if operation == "act"
               else {} if operation == "finish" else None)
    req = Request(url.rstrip("/") + "/" + operation,
                  data=json.dumps(payload).encode() if payload is not None else None,
                  headers={"Content-Type": "application/json"})
    try:
        # Never retry a non-idempotent step with a new id; do not use external HTTP proxies.
        with build_opener(ProxyHandler({})).open(req, timeout=90) as response:
            result = json.load(response)
    except HTTPError as exc:
        message = json.loads(exc.read()).get("error", "Environment request failed")
        raise RuntimeError(message) from None
    except (URLError, TimeoutError) as exc:
        suffix = f"; query observe/status before retrying with id {payload['id']}" if operation == "act" else ""
        raise RuntimeError(f"Environment response unavailable{suffix}") from exc
    encoded = result.pop("screenshot_base64", None)
    if encoded is not None:
        directory = Path(tempfile.gettempdir()) / "orbit-computer"
        directory.mkdir(mode=0o700, exist_ok=True)
        with tempfile.NamedTemporaryFile(prefix=f"step-{result['step']}-", suffix=".png",
                                         dir=directory, delete=False) as stream:
            stream.write(base64.b64decode(encoded, validate=True))
            result["screenshot"] = stream.name
    return result


def mcp():
    from mcp.server.fastmcp import FastMCP
    server = FastMCP("orbit-computer")

    @server.tool(name="spec")
    def spec() -> dict:
        """Read the original BrowserGym action description, observation mode and budget."""
        return call("spec")

    @server.tool(name="observe")
    def observe() -> dict:
        """Read the original task goal and screenshot path; does not execute an action."""
        return call("observe")

    @server.tool(name="act")
    def act(action: str, id: str = "") -> dict:
        """Execute one original BrowserGym action; reuse id only to recover the same call."""
        return call("act", action, id or None)

    @server.tool(name="finish")
    def finish() -> dict:
        """Stop the episode and save its official reward. No new actions are accepted."""
        return call("finish")

    server.run(transport="stdio")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="operation", required=True)
    for name in ("spec", "observe", "status", "finish", "mcp"):
        sub.add_parser(name)
    act = sub.add_parser("act")
    act.add_argument("action", help="one original BrowserGym high-level action string")
    act.add_argument("--id", help="reuse this id only for the identical action after response loss")
    args = parser.parse_args()
    if args.operation == "mcp":
        mcp()
        return
    try:
        print(json.dumps(call(args.operation, getattr(args, "action", None), getattr(args, "id", None)),
                         ensure_ascii=False, allow_nan=False))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
