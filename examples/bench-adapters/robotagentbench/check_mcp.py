"""Real MCP transport with the upstream's explicit CPU worker fixture, never physics."""
import argparse
import asyncio
from http.server import ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
import threading


async def check(source):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    sys.path[:0] = [str(source / "src"), str(source / "tests")]
    from test_codex_raw_bridge import FakeWorker, ready, result
    from robotagentbench.model_examples.codex.raw_bridge import RawRobotBridge
    import service
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        finished = result(1, 1)
        finished["episode_finished"] = True
        worker = FakeWorker(ready(), [result(), result(status="rejected"), finished])
        bridge = RawRobotBridge(worker, root / "observations", max_model_responses=1000000)
        service.ROOT = root
        server = ThreadingHTTPServer(("127.0.0.1", 0), service.make_handler(service.RobotService(bridge, {})))
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            script = ("import sys,asyncio;sys.path.insert(0," + repr(str(Path(__file__).parent)) + ");"
                      "import proxy;proxy.URL=" + repr("http://127.0.0.1:" + str(server.server_port))
                      + ";asyncio.run(proxy.mcp())")
            parameters = StdioServerParameters(command=sys.executable, args=["-B", "-c", script])
            async with stdio_client(parameters) as streams:
                async with ClientSession(*streams) as session:
                    await session.initialize()
                    tools = await session.list_tools()
                    assert {row.name for row in tools.tools} == {"observe", "execute_actions", "done"}
                    observed = await session.call_tool("observe", {})
                    assert not observed.isError
                    assert sum(row.type == "image" for row in observed.content) == 3
                    assert "Robot contract:" in observed.content[0].text
                    rejected = await session.call_tool("execute_actions", {"actions": [[0.0] * 22]})
                    assert rejected.isError
                    accepted = await session.call_tool("execute_actions", {"actions": [[0.0] * 22]})
                    assert not accepted.isError and bridge.completed
                    assert len(worker.calls) == 3
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
    print("passed: real MCP schemas, original public text/images, rejection and one-send actions; CPU fixture only")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    asyncio.run(check(parser.parse_args().source.resolve(strict=True)))
