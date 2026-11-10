"""VIMA prompt and service lifecycle checks with synthetic assets and inference."""

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

from orbit_embodied.assets import tree_digest
from orbit_embodied.binding import file_digest
from orbit_embodied.vima_bench import prompt_context, unpack_prompt_context
from orbit_embodied.wire import pack, unpack


class VIMATests(unittest.TestCase):
    def test_prompt_context_round_trips_object_and_scene_assets(self):
        def asset(kind, offset, mask_ids, object_info):
            rgb = np.arange(18, dtype=np.uint8).reshape(3, 2, 3) + offset
            mask = np.array([[0, mask_ids[0], 0], [0, 0, mask_ids[1]]], dtype=np.uint8)
            return {"placeholder_type": kind, "rgb": {"front": rgb, "top": rgb + 20},
                    "segm": {"front": mask, "top": mask[:, ::-1], "obj_info": object_info}}

        assets = {
            "object": asset("object", 0, (17, 17), {"obj_id": np.int64(17), "obj_name": "synthetic block"}),
            "scene": asset("scene", 40, (29, 17), [{"obj_id": np.int64(29)}, {"obj_id": np.int64(17)}]),
        }
        bounds = {"low": np.array([0.25, -0.5], dtype=np.float32),
                  "high": np.array([0.75, 0.5], dtype=np.float32)}
        env = SimpleNamespace(prompt_assets=assets, meta_info={
            "obj_id_to_info": {29: {}, 17: {}}, "action_bounds": bounds,
        })
        decoded = unpack_prompt_context(prompt_context(env))
        self.assertEqual(decoded["objectIds"], [29, 17])
        self.assertEqual(decoded["assets"].keys(), assets.keys())
        self.assertEqual(decoded["assets"]["object"]["segm"]["obj_info"], {"obj_id": 17})
        self.assertEqual(decoded["assets"]["scene"]["segm"]["obj_info"], [{"obj_id": 29}, {"obj_id": 17}])

        def assert_array(actual, expected):
            self.assertEqual(actual.dtype, expected.dtype)
            np.testing.assert_array_equal(actual, expected)

        for name, original in assets.items():
            restored = decoded["assets"][name]
            self.assertEqual(restored["placeholder_type"], original["placeholder_type"])
            for modality in ("rgb", "segm"):
                for view in ("front", "top"):
                    with self.subTest(asset=name, modality=modality, view=view):
                        assert_array(restored[modality][view], original[modality][view])
        for key, original in bounds.items():
            assert_array(decoded["bounds"][key], original)

    def test_policy_service_resets_history_on_the_next_episode(self):
        path = Path(__file__).resolve().parents[2] / "bench-adapters/embodied/serve_vima.py"
        spec = importlib.util.spec_from_file_location("serve_vima", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        class SyntheticVIMAPolicy(module.VIMAPolicy):
            def __init__(self, weights):
                self.reset()

            def __call__(self, observation):
                if self.context is None:
                    self.context = observation["episode"]
                self.obs_tokens.append(None)
                self.obs_masks.append(None)
                self.action_tokens.append(None)
                actions = np.zeros((1, 12), dtype=np.float32)
                actions[0, :4] = (self.context, len(self.obs_tokens), len(self.obs_masks), len(self.action_tokens))
                return actions

        async def check_connections():
            ready = asyncio.get_running_loop().create_future()

            @asynccontextmanager
            async def listen(handler, _host, port, **options):
                async with serve(handler, "127.0.0.1", port, **options) as server:
                    ready.set_result(server.sockets[0].getsockname()[1])
                    yield server

            # Capture the entrypoint's server coroutine to run on the test's loop.
            run = Mock()
            with tempfile.TemporaryDirectory() as temporary:
                weights = Path(temporary)
                tokenizer = weights / module.TOKENIZER
                tokenizer.write_text("synthetic tokenizer")
                argv = ["serve_vima.py", "--weights", str(weights), "--port", "0",
                        "--checkpoint-digest", tree_digest(weights), "--normalization-digest", file_digest(tokenizer)]
                with patch.object(sys, "argv", argv), patch.object(module, "VIMAPolicy", SyntheticVIMAPolicy), \
                        patch.object(module, "asyncio", SimpleNamespace(run=run)):
                    module.main()

                with patch("websockets.server.serve", listen):
                    server_task = asyncio.create_task(run.call_args.args[0])
                    try:
                        url = f"ws://127.0.0.1:{await ready}"
                        for episode, steps in ((7, (1, 2)), (11, (1,))):
                            async with connect(url, close_timeout=1) as client:
                                self.assertEqual(unpack(await client.recv())["actionSize"], 12)
                                for step in steps:
                                    await client.send(pack({"episode": episode}))
                                    actions = unpack(await client.recv())["actions"]
                                    np.testing.assert_array_equal(actions[0, :4], [episode, step, step, step])
                    finally:
                        server_task.cancel()
                        with suppress(asyncio.CancelledError):
                            await server_task

        asyncio.run(asyncio.wait_for(check_connections(), timeout=5))
