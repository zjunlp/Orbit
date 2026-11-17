"""Agent-side public robot tools. Never retries an uncertain physical request."""
import asyncio
import json
import sys
import urllib.request
import uuid

URL = "http://environment:8765"


def request(path, value=None):
    raw = None if value is None else json.dumps(value, allow_nan=False).encode()
    req = urllib.request.Request(URL + path, data=raw, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=900) as response:
        return json.load(response)


def empty():
    for _ in range(1000):
        state = request("/initial")
        if state["completed"]:
            return
        order = state["contract"]["action_order"]
        joints = state["observation"]["joints"]
        hold = [joints[name] for name in order[:20]] + [0.0, 0.0]
        result = request("/call", {"name": "execute_actions", "arguments": {"actions": [hold] * 600},
                                    "id": uuid.uuid4().hex})
        if not result["success"]:
            raise RuntimeError("Native no-op action was rejected")
    raise RuntimeError("Native no-op control did not reach its own termination")


async def mcp():
    from mcp.server import Server
    from mcp.server.stdio import stdio_server
    from mcp.types import Tool, TextContent, ImageContent, CallToolResult
    server = Server("robotagentbench")
    lock = asyncio.Lock()

    @server.list_tools()
    async def tools():
        rows = await asyncio.to_thread(request, "/tools")
        return [Tool(name=row["name"], description=row["description"], inputSchema=row["inputSchema"]) for row in rows]

    @server.call_tool()
    async def call(name, arguments):
        async with lock:
            result = await asyncio.to_thread(request, "/call",
                {"name": name, "arguments": arguments, "id": uuid.uuid4().hex})
        content = []
        for item in result["contentItems"]:
            if item["type"] == "inputText":
                content.append(TextContent(type="text", text=item["text"]))
            elif item["type"] == "inputImage":
                prefix, data = item["imageUrl"].split(",", 1)
                if prefix != "data:image/png;base64":
                    raise ValueError("Expected original PNG observation")
                content.append(ImageContent(type="image", data=data, mimeType="image/png"))
            else:
                raise ValueError("Unknown native public content")
        return CallToolResult(content=content, isError=not result["success"])

    async with stdio_server() as streams:
        await server.run(*streams, server.create_initialization_options())


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "empty":
        empty()
    else:
        asyncio.run(mcp())
