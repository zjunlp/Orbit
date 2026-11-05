#!/usr/bin/env -S python3 -B
"""Stdio MCP server through which a CLI Agent holds one BFCL multi-turn conversation.

The Agent asks for each user turn, lists the functions available in that turn, calls them on the
upstream BFCL instances and ends the turn with its reply. Every call is recorded in the same
`evidence.json` format as the fixed driver, so verify replays it independently; nothing the Agent
or this server reports is trusted for the score. Standard library only (newline-delimited JSON-RPC).
"""

import inspect
import json
import os
from pathlib import Path
import sys

import runtime

PROTOCOL = "2024-11-05"
TOOLS = [
    {"name": "get_user_message",
     "description": "End the current turn (optionally with your reply to the user) and receive the "
                    "next user message. Call it first; when it reports finished, the conversation is over.",
     "inputSchema": {"type": "object", "properties": {
         "response": {"type": "string", "description": "Your reply to the user for the turn you are ending"}}}},
    {"name": "list_functions",
     "description": "JSON schemas of the functions you may call in the current turn.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "call_function",
     "description": "Call one of the listed functions with keyword arguments and get its result.",
     "inputSchema": {"type": "object", "required": ["name"], "properties": {
         "name": {"type": "string"},
         "arguments": {"type": "object", "description": "Keyword arguments, as in the function schema"}}}},
]


class Conversation:
    def __init__(self, payload, output, api=None):
        self.payload, self.output = payload, output
        entry = payload["entry"]
        execute = (api or runtime.upstream())[0]
        _, self.instances = execute([], initial_config=entry["initial_config"],
                                    involved_classes=entry["involved_classes"],
                                    model_name="orbit_agent", test_entry_id=entry["id"],
                                    long_context="long_context" in entry["id"], is_evaL_run=True)
        self.methods = {name: m for obj in self.instances.values()
                        for name, m in inspect.getmembers(obj, predicate=inspect.ismethod)
                        if not name.startswith("_")}
        self.trace = {"task": entry["id"], "seed": payload["seed"], "version": runtime.VERSION,
                      "digests": payload["digests"], "producer": "agent-mcp",
                      "trust": "self-reported; independently replayed in verify",
                      "tools": payload["tools"], "initial_state": runtime.state(self.instances), "turns": []}
        self.turn = -1
        self.save()

    @property
    def turns(self):
        return len(self.payload["entry"]["question"])

    def next_turn(self, response=""):
        if 0 <= self.turn < self.turns:
            row = self.trace["turns"][self.turn]
            row["state_after"] = runtime.state(self.instances)
            row["final_response"] = response or ""
        if self.turn + 1 >= self.turns:
            self.turn = self.turns
            self.save()
            return {"finished": True, "note": "The conversation is over; stop now."}
        before = set(runtime.toolset(self.payload, self.turn)) if self.turn >= 0 else None
        self.turn += 1
        available = runtime.toolset(self.payload, self.turn)
        messages = self.payload["entry"]["question"][self.turn]
        self.trace["turns"].append({"turn": self.turn, "messages": messages,
                                    "available_tools": list(available),
                                    "state_before": runtime.state(self.instances),
                                    "calls": [], "final_response": ""})
        self.save()
        added = sorted(set(available) - before) if before is not None else []
        reply = {"finished": False, "turn": self.turn + 1, "of": self.turns,
                 "messages": [{"role": m.get("role"), "content": m.get("content")} for m in messages]}
        if added:
            reply["newly_available_functions"] = added
        if not messages:
            reply["note"] = "No new user message: new functions are available; continue the user's request if you can."
        return reply

    def functions(self):
        if self.turn < 0 or self.turn >= self.turns:
            raise ValueError("Call get_user_message first" if self.turn < 0 else "The conversation is over")
        return list(runtime.toolset(self.payload, self.turn).values())

    def call(self, name, arguments):
        if self.turn < 0 or self.turn >= self.turns:
            raise ValueError("Call get_user_message first" if self.turn < 0 else "The conversation is over")
        if not isinstance(arguments, dict):
            raise ValueError("arguments must be an object")
        source = f"{name}(" + ", ".join(f"{k}={v!r}" for k, v in arguments.items()) + ")"
        row = self.trace["turns"][self.turn]
        call = {"id": f"turn-{self.turn}-call-{len(row['calls'])}", "source": source}
        row["calls"].append(call)
        available = runtime.toolset(self.payload, self.turn)
        try:
            fname, args, kw, canonical = runtime.parse_call(source, available)
            call.update({"name": fname, "args": runtime.jsonable(args), "kwargs": runtime.jsonable(kw)})
            mismatch = runtime.check_arguments(self.methods[fname], args, kw, available[fname])
        except runtime.ActionError as exc:
            call.update({"action_error": str(exc), "result": None})
            self.save()
            return f"Error: {exc}"
        try:
            result = runtime.call_tool(self.methods[fname], args, kw, mismatch)
        except runtime.RuntimeFailure as exc:
            call.update({"decoded": canonical, "result": None, "environment_error": str(exc)})
            self.save()
            return f"Error during execution: {exc}"
        call.update({"decoded": canonical, "result": result})
        self.save()
        return result

    def save(self):
        """Evidence for every turn; turns the Agent never reached have no calls."""
        trace = json.loads(json.dumps(self.trace, default=str))
        current = runtime.state(self.instances)
        for i in range(len(trace["turns"]), self.turns):
            trace["turns"].append({"turn": i, "messages": self.payload["entry"]["question"][i],
                                   "available_tools": list(runtime.toolset(self.payload, i)),
                                   "state_before": current, "calls": [], "final_response": "",
                                   "reached": False})
        for row in trace["turns"]:
            row.setdefault("state_after", current)
        tmp = self.output / "evidence.json.tmp"
        runtime.write_json(tmp, trace)
        os.replace(tmp, self.output / "evidence.json")


def handle(conv, msg):
    method, params = msg.get("method"), msg.get("params") or {}
    if method == "initialize":
        return {"protocolVersion": params.get("protocolVersion", PROTOCOL),
                "capabilities": {"tools": {}}, "serverInfo": {"name": "bfcl", "version": runtime.VERSION}}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "ping":
        return {}
    if method == "tools/call":
        name, args = params.get("name"), params.get("arguments") or {}
        try:
            if name == "get_user_message":
                out = conv.next_turn(str(args.get("response") or ""))
            elif name == "list_functions":
                out = conv.functions()
            elif name == "call_function":
                out = conv.call(str(args.get("name") or ""), args.get("arguments") or {})
            else:
                raise ValueError(f"Unknown tool: {name}")
            text = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False)
            return {"content": [{"type": "text", "text": text}], "isError": False}
        except ValueError as exc:
            return {"content": [{"type": "text", "text": f"Error: {exc}"}], "isError": True}
    raise LookupError(method)


def serve(conv, stdin=sys.stdin, stdout=sys.stdout):
    for line in stdin:
        if not line.strip():
            continue
        msg = json.loads(line)
        if "id" not in msg:
            continue  # notifications
        try:
            reply = {"jsonrpc": "2.0", "id": msg["id"], "result": handle(conv, msg)}
        except LookupError:
            reply = {"jsonrpc": "2.0", "id": msg["id"],
                     "error": {"code": -32601, "message": f"Method not found: {msg.get('method')}"}}
        stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
        stdout.flush()


if __name__ == "__main__":
    path = Path(os.environ["BFCL_PAYLOAD"])
    payload = json.loads(path.read_text())
    # The task's later user turns stay with this server, not in a file the Agent can read.
    path.unlink(missing_ok=True)
    serve(Conversation(payload, Path(os.environ["BFCL_OUTPUT"])))
