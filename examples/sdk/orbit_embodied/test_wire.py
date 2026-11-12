import asyncio
from contextlib import asynccontextmanager, suppress
import threading
import unittest
from unittest.mock import patch

from websockets.client import connect
from websockets.server import serve

from .wire import pack, serve_actions, unpack


class TestPolicyTransport(unittest.TestCase):
    def test_ping_is_served_during_synchronous_inference(self):
        async def check():
            loop = asyncio.get_running_loop()
            ready = loop.create_future()
            started = asyncio.Event()
            finish = threading.Event()

            def policy(_observation):
                loop.call_soon_threadsafe(started.set)
                return [int(finish.wait(timeout=2))]

            @asynccontextmanager
            async def listen(handler, host, port, **options):
                async with serve(handler, host, port, **options) as server:
                    ready.set_result(server.sockets[0].getsockname()[1])
                    yield server

            with patch("websockets.server.serve", listen):
                server_task = asyncio.create_task(serve_actions(policy, {}, "127.0.0.1", 0))
                try:
                    async with connect(f"ws://127.0.0.1:{await ready}", close_timeout=1) as client:
                        await client.recv()
                        await client.send(pack({}))
                        await started.wait()
                        pong = await client.ping()
                        await pong
                        finish.set()
                        self.assertEqual(unpack(await client.recv()), {"actions": [1]})
                finally:
                    finish.set()
                    server_task.cancel()
                    with suppress(asyncio.CancelledError):
                        await server_task

        asyncio.run(asyncio.wait_for(check(), timeout=5))
