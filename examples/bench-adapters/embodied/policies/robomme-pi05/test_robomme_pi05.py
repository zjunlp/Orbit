"""Episode-scoped sampling through a shared RoboMME policy service."""

import asyncio
from contextlib import asynccontextmanager, suppress
import importlib.util
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import numpy as np
from websockets.client import connect
from websockets.server import serve

from orbit_embodied.wire import pack, serve_actions, unpack


class RoboMMEPi05Tests(unittest.TestCase):
    def test_shared_service_restarts_the_declared_stream_at_each_episode(self):
        path = Path(__file__).with_name("serve_robomme_pi05.py")
        spec = importlib.util.spec_from_file_location("robomme_pi05_service", path)
        service = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(service)

        class Policy:
            def __init__(self, seed):
                self.seed = self.next_key = seed

            def reset(self):
                self.next_key = self.seed

            def infer(self, observation):
                self.next_key += 1
                return {"actions": np.full((20, 8), self.next_key, dtype=np.float32)}

        factory = Mock(side_effect=lambda config, checkpoint, seed: Policy(seed))
        modules = {
            "mme_vla_suite.policies.policy_config": SimpleNamespace(create_trained_policy=factory),
            "mme_vla_suite.training.config": SimpleNamespace(get_config=lambda name: name),
        }
        with tempfile.TemporaryDirectory() as directory, patch.dict(sys.modules, modules), patch.dict(service.os.environ):
            root = Path(directory)
            tokenizer = root / service.TOKENIZER
            tokenizer.parent.mkdir()
            tokenizer.write_bytes(b"synthetic tokenizer")
            with patch("tempfile.mkdtemp", return_value=directory):
                infer, reset = service.build(root)

        randomness = {"backend": "jax", "initialKey": 0, "scope": "episode"}
        self.assertEqual(service.RANDOMNESS, randomness)
        factory.assert_called_once_with("pi05_baseline", root / service.CHECKPOINT, seed=randomness["initialKey"])
        metadata = {"orbit": {"randomness": service.RANDOMNESS}}
        observation = {key: [] for key in ("front_rgb", "wrist_rgb", "joint_state")}
        observation["instruction"] = "Pick the highlighted block."

        async def check():
            port = asyncio.get_running_loop().create_future()

            @asynccontextmanager
            async def listen(handler, host, requested, **options):
                async with serve(handler, host, requested, **options) as server:
                    port.set_result(server.sockets[0].getsockname()[1])
                    yield server

            with patch("websockets.server.serve", listen):
                task = asyncio.create_task(serve_actions(infer, metadata, "127.0.0.1", 0, reset=reset))
                try:
                    url = f"ws://127.0.0.1:{await port}"
                    for _ in range(2):
                        async with connect(url) as client:
                            self.assertEqual(unpack(await client.recv())["orbit"]["randomness"], randomness)
                            for value in (1, 2):
                                await client.send(pack(observation))
                                actions = unpack(await client.recv())["actions"]
                                np.testing.assert_array_equal(actions, np.full((20, 8), value))
                finally:
                    task.cancel()
                    with suppress(asyncio.CancelledError):
                        await task

        asyncio.run(asyncio.wait_for(check(), timeout=5))
