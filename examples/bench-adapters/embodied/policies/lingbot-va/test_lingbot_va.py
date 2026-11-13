"""LingBot-VA's RoboTwin protocol with a synthetic environment and predictor."""

import asyncio
from contextlib import asynccontextmanager, suppress
import importlib.util
import json
from pathlib import Path
import runpy
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import numpy as np
from websockets.client import connect
from websockets.server import serve


from orbit_embodied import digest, resolve_binding, run_episode, verify_episode
from orbit_embodied.binding import seed_asset
from orbit_embodied.evidence import seal
from orbit_embodied.robotwin import RoboTwinLingBotBenchmark
from orbit_embodied.wire import pack, unpack


HERE = Path(__file__).resolve().parent
ADAPTER = HERE.parents[1]
CAMERA_SLOTS = {
    "head_camera": "observation.images.cam_high",
    "left_camera": "observation.images.cam_left_wrist",
    "right_camera": "observation.images.cam_right_wrist",
}


def prediction(start):
    raw = np.zeros((16, 2, 16), dtype=np.float32)
    raw[0] = np.arange(start, start + 32).reshape(2, 16)
    raw[[4, 6, 14]] = np.sqrt(0.5)
    raw[13] = -np.sqrt(0.5)
    raw[7], raw[15] = 0.25, 0.75
    return raw


class LingBotVATests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location(
            "serve_lingbot_va", HERE / "serve_lingbot_va.py",
        )
        self.service = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.service)

    def test_keyframes_and_raw_feedback_follow_the_chunk_schedule_across_episodes(self):
        service = self.service
        raw_chunks = [prediction(start) for start in (0, 32, 64, 96)]
        model = Mock()
        model.infer.side_effect = [None, {"action": raw_chunks[0].copy()},
                                   None, {"action": raw_chunks[1].copy()},
                                   None, {"action": raw_chunks[2].copy()},
                                   None, {"action": raw_chunks[3].copy()}]

        profile = json.loads((ADAPTER / "profiles/robotwin-demo-clean.json").read_text())
        profile["environment"]["assets"]["digest"] = "sha256:" + "1" * 64
        benchmark = RoboTwinLingBotBenchmark(profile, "adjust_bottle")
        frames = {name: {"rgb": np.zeros((2, 2, 3), dtype=np.uint8)} for name in CAMERA_SLOTS}
        env = Mock(step_lim=400, take_action_cnt=0, eval_success=False)
        env.robot.get_left_arm_jointState.return_value = [0] * 7
        env.robot.get_right_arm_jointState.return_value = [0] * 7
        base = 0
        reads = []

        def get_obs():
            reads.append(env.take_action_cnt)
            for offset, camera in enumerate(frames.values()):
                camera["rgb"].fill(base + env.take_action_cnt + offset)
            return {"observation": frames, "joint_action": {"vector": np.zeros(14)}}

        def take_action(_action, *, action_type):
            self.assertEqual(action_type, "ee")
            env.take_action_cnt += 1

        env.get_obs.side_effect = get_obs
        env.take_action.side_effect = take_action
        sample = {"taskId": "adjust_bottle", "environmentSeed": 42, "initialStateId": "0",
                  "initialStateDigest": seed_asset(profile, "adjust_bottle")}

        def reset(prompt, x):
            half = np.sqrt(0.5)
            env.take_action_cnt = 0
            env.get_instruction.return_value = prompt
            env.now_obs = {"endpose": {
                "left_endpose": [x, 2, 3, half, 0, 0, half], "left_gripper": 0.1,
                "right_endpose": [4, 5, 6, 0, half, 0, half], "right_gripper": 0.9,
            }}
            with patch.object(benchmark, "_native_args"), patch.object(benchmark, "_instruction", return_value=prompt), \
                    patch.object(benchmark, "_expert_scene", return_value=(env, {})), \
                    patch("orbit_embodied.robotwin.setup_native_scene"):
                observation = benchmark.reset(sample)
            for offset, name in enumerate(CAMERA_SLOTS):
                np.testing.assert_array_equal(observation[name + "_history"],
                                              np.full((8, 2, 2, 3), base + offset, dtype=np.uint8))
            return observation

        async def check_connections():
            nonlocal base
            ready = asyncio.get_running_loop().create_future()

            @asynccontextmanager
            async def listen(handler, _host, _port, **options):
                async with serve(handler, "127.0.0.1", 0, **options) as server:
                    ready.set_result(server.sockets[0].getsockname()[1])
                    yield server

            upstream = SimpleNamespace(
                __file__="synthetic_server.py", VA_CONFIGS={"robotwin": SimpleNamespace()},
                init_logger=Mock(), VA_Server=Mock(return_value=model),
            )
            argv = ["serve_lingbot_va.py", "--weights", "synthetic-weights",
                    "--checkpoint-digest", "checkpoint", "--normalization-digest", "normalization"]
            run = Mock()
            with patch.dict(sys.modules, {"torch": Mock(), "wan_va_server": upstream}), \
                    patch.object(sys, "argv", argv), patch.object(service, "asyncio", SimpleNamespace(run=run)), \
                    patch.object(service, "checkpoint_digest", return_value="checkpoint"), \
                    patch.object(service, "file_digest", return_value="normalization"):
                service.main()

            with patch("websockets.server.serve", listen):
                server_task = asyncio.create_task(run.call_args.args[0])
                try:
                    url = f"ws://127.0.0.1:{await ready}"
                    observation = reset("first episode", x=1)
                    reads.clear()
                    async with connect(url, close_timeout=1) as client:
                        metadata = unpack(await client.recv())
                        self.assertEqual((metadata["actionSize"], metadata["replanSteps"]), (16, 32))
                        for start, count in ((16, 16), (32, 32), (64, 32)):
                            await client.send(pack(observation))
                            actions = unpack(await client.recv())["actions"]
                            self.check_actions(actions, start, count, x=1)
                            for index, action in enumerate(actions, start=1):
                                observation = benchmark.step(action).observation
                                self.assertEqual("head_camera_history" in observation, index == count)
                    self.assertEqual(reads, list(range(4, 81, 4)))

                    base = 100
                    observation = reset("second episode", x=-3)
                    async with connect(url, close_timeout=1) as client:
                        await client.recv()
                        await client.send(pack(observation))
                        self.check_actions(unpack(await client.recv())["actions"], 112, 16, x=-3)
                finally:
                    server_task.cancel()
                    with suppress(asyncio.CancelledError):
                        await server_task

        asyncio.run(asyncio.wait_for(check_connections(), timeout=5))
        calls = [call.args[0] for call in model.infer.call_args_list]
        self.assertEqual(len(calls), 8)
        for index, prompt, value in ((0, "first episode", 0), (6, "second episode", 100)):
            self.assertEqual(calls[index], {"reset": True, "prompt": prompt, "save_visualization": False})
            self.check_frames([calls[index + 1]["obs"]], [value], prompt)
            self.assertEqual(calls[index + 1]["prompt"], prompt)
        for index, frames, raw in ((2, range(4, 17, 4), raw_chunks[0]), (4, range(20, 49, 4), raw_chunks[1])):
            cache = calls[index]
            self.assertEqual({key: cache[key] for key in ("compute_kv_cache", "imagine", "save_visualization")},
                             {"compute_kv_cache": True, "imagine": False, "save_visualization": False})
            np.testing.assert_array_equal(cache["state"], raw)
            self.check_frames(cache["obs"], frames, "first episode")
            self.check_frames([calls[index + 1]["obs"]], [0], "first episode")

    def test_episode_stops_and_verifies_only_consistent_native_evidence(self):
        task, horizon = "adjust_bottle", 53
        reference = json.loads((ADAPTER / "profiles/robotwin-demo-clean.json").read_text())
        reference["environment"]["horizons"][task] = horizon
        reference["environment"]["assets"]["digest"] = "sha256:" + "1" * 64
        for name in CAMERA_SLOTS:
            reference["benchmarkProfile"]["observations"][name]["shape"] = [2, 2, 3]
        with patch.object(sys, "path", [str(HERE), *sys.path]):
            configure = runpy.run_path(str(HERE / "configure_lingbot_va.py"))
        configure["reference_for_policy"](reference)
        binding = resolve_binding(reference["benchmarkProfile"], reference["policyProfile"],
                                  reference["observationMap"])
        sample = {"taskId": task, "benchmarkProfile": reference["id"], "environmentSeed": 42,
                  "initialStateId": "0", "initialStateDigest": seed_asset(reference, task)}
        sample["sampleId"] = digest(sample)

        with TemporaryDirectory() as directory:
            for name, success_at, steps, sources in (
                ("success", 19, 19, [0, 16]),
                ("horizon", None, horizon, [0, 16, 48]),
            ):
                with self.subTest(termination=name):
                    output = Path(directory) / name
                    result = self.run_synthetic_episode(reference, binding, sample, output, success_at)
                    self.assertTrue(result["valid"], result["issues"])
                    verified = verify_episode(output, sample["sampleId"], name)
                    self.assertTrue(verified["valid"])
                    self.assertEqual((verified["success"], verified["steps"]), (success_at is not None, steps))
                    self.assertEqual(verified["native"]["termination"], name)
                    actions = output / "actions.jsonl"
                    controls = [json.loads(line) for line in actions.read_text().splitlines()]
                    self.assertEqual([row["step"] for row in controls if row["terminated"]], [steps - 1])
                    self.assertEqual([row["step"] for row in controls if row["chunkIndex"] == 0], sources)
                    if name == "horizon":
                        self.check_rejected_evidence(output, result, controls)

    def check_rejected_evidence(self, output, result, controls):
        pose = controls[0]["state"]["initial_ee_pose"].copy()
        pose[0] += 1
        invalid_pose = {**controls[0]["state"], "initial_ee_pose": pose}
        stop_error = "stopped outside the native success or horizon boundary"
        for rows, message in (
            ([{**controls[0], "state": invalid_pose}, *controls[1:]], "action or episode pose differs"),
            ([{**controls[0], "terminated": True}, *controls[1:]], stop_error),
            ([*controls[:-2], {**controls[-2], "terminated": True}], stop_error),
        ):
            with self.subTest(rejection=message, steps=len(rows)):
                (output / "actions.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))
                # Reseal so the verifier reaches the protocol checks after validating the hashes.
                seal(output, {**result, "steps": len(rows)})
                with self.assertRaisesRegex(ValueError, message):
                    verify_episode(output, result["sampleRef"], result["episodeId"])

    def run_synthetic_episode(self, reference, binding, sample, output, success_at):
        benchmark = RoboTwinLingBotBenchmark(reference, sample["taskId"])
        env = Mock(step_lim=benchmark.horizon, take_action_cnt=0, eval_success=False)
        env.get_instruction.return_value = "adjust the bottle"
        env.robot.get_left_arm_jointState.return_value = [0] * 7
        env.robot.get_right_arm_jointState.return_value = [0] * 7
        env.now_obs = {"endpose": {
            "left_endpose": [1, 2, 3, 0, 0, 0, 1], "left_gripper": 0.1,
            "right_endpose": [4, 5, 6, 0, 0, 0, 1], "right_gripper": 0.9,
        }}
        env.get_obs.return_value = {
            "observation": {name: {"rgb": np.zeros((2, 2, 3), dtype=np.uint8)} for name in CAMERA_SLOTS},
            "joint_action": {"vector": np.zeros(14)},
        }

        def take_action(_action, *, action_type):
            self.assertEqual(action_type, "ee")
            env.take_action_cnt += 1
            env.eval_success = env.take_action_cnt == success_at

        env.take_action.side_effect = take_action
        model = Mock()
        model.infer.side_effect = [None, {"action": prediction(0)}, None, {"action": prediction(32)},
                                   None, {"action": prediction(64)}]
        actor = self.service.LingBotPolicy(model)
        policy = SimpleNamespace(replan_steps=32, reset=lambda _sample: actor.reset(), act=actor.infer, close=Mock())
        with patch.object(benchmark, "_native_args"), patch.object(benchmark, "_instruction", return_value="adjust the bottle"), \
                patch.object(benchmark, "_expert_scene", return_value=(env, {})), patch.object(benchmark, "start_video"), \
                patch("orbit_embodied.robotwin.setup_native_scene"):
            return run_episode(benchmark, policy, sample, binding, output, output.name, {"reference": reference})

    def check_frames(self, frames, steps, prompt):
        self.assertEqual(len(frames), len(steps))
        for frame, step in zip(frames, steps):
            self.assertEqual(frame["task"], prompt)
            for offset, slot in enumerate(CAMERA_SLOTS.values()):
                np.testing.assert_array_equal(frame[slot], np.full((2, 2, 3), step + offset, dtype=np.uint8))

    def check_actions(self, actions, start, count, *, x):
        # The pinned client composes initial * relative quaternions in xyzw order.
        expected = np.tile([x, 2, 3, 0.5, 0.5, 0.5, 0.5, 0.25,
                            4, 5, 6, -0.5, 0.5, -0.5, 0.5, 0.75], (count, 1))
        expected[:, 0] += np.arange(start, start + count)
        np.testing.assert_allclose(actions, expected, rtol=0, atol=1e-12)
