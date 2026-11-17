import asyncio
from contextlib import asynccontextmanager, suppress
import threading
import unittest
from unittest.mock import patch

import numpy as np
from websockets.client import connect
from websockets.server import serve

from .policy_ws import PolicyClient
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
                return [int(finish.wait(timeout=2))], "empty-plan"

            @asynccontextmanager
            async def listen(handler, host, port, **options):
                async with serve(handler, host, port, **options) as server:
                    ready.set_result(server.sockets[0].getsockname()[1])
                    yield server

            with patch("websockets.server.serve", listen):
                server_task = asyncio.create_task(serve_actions(policy, {}, "127.0.0.1", 0, report_fallback=True))
                try:
                    async with connect(f"ws://127.0.0.1:{await ready}", close_timeout=1) as client:
                        await client.recv()
                        await client.send(pack({}))
                        await started.wait()
                        pong = await client.ping()
                        await pong
                        finish.set()
                        self.assertEqual(unpack(await client.recv()), {"actions": [1], "fallback": "empty-plan"})
                finally:
                    finish.set()
                    server_task.cancel()
                    with suppress(asyncio.CancelledError):
                        await server_task

        asyncio.run(asyncio.wait_for(check(), timeout=5))

    def test_action_only_reply_clears_previous_fallback(self):
        client = PolicyClient.__new__(PolicyClient)
        with patch.object(client, "infer", side_effect=[
            {"actions": [0], "fallback": "empty-plan"},
            {"actions": [1]},
            {"actions": [2], "fallback": np.array(["unrecognized", "metadata"])},
        ]):
            self.assertEqual(client.act({}), [0])
            self.assertEqual(client.last_fallback, "empty-plan")
            self.assertEqual(client.act({}), [1])
            self.assertIsNone(client.last_fallback)
            self.assertEqual(client.act({}), [2])
            self.assertIsNone(client.last_fallback)
