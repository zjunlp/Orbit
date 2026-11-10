#!/usr/bin/env python3
"""Forward native MCP tools and image blocks without a model or agent loop."""
import asyncio
import os
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from mcp.server import Server
from mcp.server.stdio import stdio_server


async def main():
    async with streamablehttp_client(os.environ.get("CLBENCH_MCP_URL", "http://environment:8765/mcp")) as (incoming, outgoing, _):
        async with ClientSession(incoming, outgoing) as session:
            await session.initialize()
            server = Server("household-task")
            gate = asyncio.Lock()

            @server.list_tools()
            async def list_tools():
                return (await session.list_tools()).tools

            @server.call_tool()
            async def call_tool(name, arguments):
                async with gate:
                    return await session.call_tool(name, arguments)

            async with stdio_server() as (reader, writer):
                await server.run(reader, writer, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
