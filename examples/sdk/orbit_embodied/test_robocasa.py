"""Registration checks against an explicit synthetic RoboCasa task registry."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from orbit_embodied import run_episode, verify_episode
from orbit_embodied.binding import digest, resolve_binding, seed_asset
from orbit_embodied.evidence import seal, write_json
from orbit_embodied.robocasa import RoboCasaBenchmark, RoboCasaDiffusionBenchmark

HERE = Path(__file__).resolve().parents[2] / "bench-adapters/embodied"


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_config():
    adapter = load("robocasa_fixture_adapter", "adapter.py")
    with patch.dict(sys.modules, {"adapter": adapter}):
        groot = load("robocasa_fixture_groot", "configure_groot.py")
        with patch.dict(sys.modules, {"configure_groot": groot}):
            config = load("robocasa_fixture_config", "configure_robocasa365.py")
    return adapter, config


class RoboCasaRegistrationTests(unittest.TestCase):
    def test_diffusion_history_and_chunk_stop_follow_native_runner(self):
        observations = {"state.position": {"dtype": "float32"}, "instruction": {"dtype": "string"}}
        reference = {"parameters": {"controlHz": 20, "replanSteps": 8},
                     "environment": {"tasks": ["task"], "horizons": {"task": 16}},
                     "benchmarkProfile": {"observations": observations}}
        for first_success, stop_step in ((1, 16), (7, 8), (8, 16)):
            with self.subTest(first_success=first_success):
                benchmark = RoboCasaDiffusionBenchmark(reference, "task")
                with patch.object(RoboCasaBenchmark, "reset", lambda self, _: self.observation(
                    {"state.position": [0], "instruction": "open the drawer"}
                )):
                    initial = benchmark.reset({})
                np.testing.assert_array_equal(initial["state.position"], [[0], [0]])

                def native_step(_action):
                    benchmark.steps += 1
                    success = benchmark.steps == first_success
                    return ({"state.position": [benchmark.steps], "instruction": "changed"},
                            int(success), False, False, {"success": success})

                with patch.object(benchmark, "step_native_env", native_step):
                    for step in range(1, stop_step + 1):
                        result = benchmark.step(None)
                        np.testing.assert_array_equal(result.observation["state.position"], [[step - 1], [step]])
                        self.assertEqual(result.observation["instruction"], "open the drawer")
                        self.assertEqual(result.terminated, step == stop_step)
                self.assertTrue(benchmark.result()["success"])

    def test_diffusion_evidence_recomputes_stopping_and_accepts_legacy_runs(self):
        profile = {
            "id": "synthetic-history",
            "observations": {"state.position": {"semantic": "fixture", "dtype": "float32", "shape": [2, 1]}},
            "action": {"semantic": "fixture", "shape": [12], "controller": "fixture", "frame": "fixture",
                       "unit": "fixture", "rotation": "fixture", "gripper": "fixture"},
        }
        reference = {"id": "synthetic-diffusion", "parameters": {"controlHz": 20, "replanSteps": 8, "successRule": "any"},
                     "environment": {"protocol": "diffusion-policy", "tasks": ["task"], "horizons": {"task": 16}},
                     "benchmarkProfile": profile}
        content = {"taskId": "task", "benchmarkProfile": reference["id"], "initialStateId": "0",
                   "initialStateDigest": seed_asset(reference, "task"), "environmentSeed": 7, "policySeed": 0,
                   "repetition": 0}
        sample = {**content, "sampleId": digest(content)}
        binding = resolve_binding(profile, profile, {"state.position": "state.position"})
        identity = {"reference": reference, "policy": {"name": "synthetic-policy"},
                    "implementationDigest": "sha256:" + "b" * 64,
                    "execution": {"runId": "synthetic-run", "trialId": "synthetic-trial"}}
        expected = {"sample": sample, "binding": binding, "reference": reference, "policy": identity["policy"],
                    "solveImplementationDigest": identity["implementationDigest"], "evidenceVersion": 4,
                    "solveRunId": "synthetic-run", "executionTrialId": "synthetic-trial"}
        episode_id = "synthetic-trial.attempt"
        policy = SimpleNamespace(replan_steps=8, reset=lambda _: None,
                                 act=lambda _: np.zeros((8, 12), dtype=np.float32), close=lambda: None)

        class Fixture(RoboCasaDiffusionBenchmark):
            def start_video(self, _directory):
                pass

            def record_frame(self, _observation):
                pass

        for success_at, done_at, steps in ((1, None, 16), (None, None, 16), (7, None, 8), (None, 3, 3)):
            with self.subTest(success_at=success_at, done_at=done_at), tempfile.TemporaryDirectory() as temporary:
                benchmark = Fixture(reference, "task")

                def step_native_env(_action):
                    benchmark.steps += 1
                    success = benchmark.steps == success_at
                    return ({"state.position": [benchmark.steps]}, int(success), benchmark.steps == done_at,
                            False, {"success": success})

                directory = Path(temporary) / "episode"
                with patch.object(RoboCasaBenchmark, "reset", lambda self, _: self.observation({"state.position": [0]})), \
                        patch.object(benchmark, "step_native_env", step_native_env):
                    result = run_episode(benchmark, policy, sample, binding, directory, episode_id, identity)
                path = directory / "actions.jsonl"
                rows = [json.loads(line) for line in path.read_text().splitlines()]
                self.assertEqual(result["steps"], steps)
                self.assertEqual([row["nativeDone"] for row in rows], [i == done_at for i in range(1, steps + 1)])
                self.assertEqual(verify_episode(directory, sample["sampleId"], episode_id, expected), result)

                def save(controls, verdict):
                    path.write_text("".join(json.dumps(row) + "\n" for row in controls))
                    seal(directory, verdict)

                if steps == 16:
                    save([{**rows[0], "terminated": not result["success"]}], {**result, "steps": 1})
                    with self.assertRaisesRegex(ValueError, "stopping point"):
                        verify_episode(directory, sample["sampleId"], episode_id, expected)
                    save([{**rows[0], "reward": 1 - rows[0]["reward"]}, *rows[1:]], result)
                    with self.assertRaisesRegex(ValueError, "native sparse reward"):
                        verify_episode(directory, sample["sampleId"], episode_id, expected)
                    for suffix in ("npy", "json"):
                        chunks = directory / "chunks"
                        (chunks / ("2." + suffix)).write_bytes((chunks / ("0." + suffix)).read_bytes())
                    save([{**row, "chunk": 2} for row in rows[:8]] + rows[8:], result)
                    with self.assertRaisesRegex(ValueError, "fixed chunk schedule"):
                        verify_episode(directory, sample["sampleId"], episode_id, expected)
                else:
                    save([{**rows[0], "nativeDone": True}, *rows[1:]], result)
                    with self.assertRaisesRegex(ValueError, "stopping point"):
                        verify_episode(directory, sample["sampleId"], episode_id, expected)

                for row in rows:
                    del row["nativeDone"]
                save(rows, result)
                with self.assertRaisesRegex(ValueError, "lacks the native done signal"):
                    verify_episode(directory, sample["sampleId"], episode_id, expected)
                contract_path = directory / "contract.json"
                contract = json.loads(contract_path.read_text())
                write_json(contract_path, {**contract, "version": 2})
                seal(directory, result)
                with self.assertRaisesRegex(ValueError, "another solve Run"):
                    verify_episode(directory, sample["sampleId"], episode_id, expected)
                legacy = {**expected, "evidenceVersion": 2}
                self.assertEqual(verify_episode(directory, sample["sampleId"], episode_id, legacy), result)

    def test_drinkware_observation_is_read_after_opening_the_door(self):
        class Native:
            def __init__(self):
                self.sim = SimpleNamespace(forward=lambda: self.events.append("forward"))
                self.events = []

            def reset(self):
                self.events.append("open door")

            def _get_observations(self, *, force_update):
                if force_update:
                    self.events.append("observe")
                return {"door": "open"}

        native = Native()
        benchmark = object.__new__(RoboCasaBenchmark)
        benchmark.env = SimpleNamespace(unwrapped=SimpleNamespace(env=native),
                                        reset=lambda: (native.reset(), {}))
        self.assertEqual(benchmark.reset_drinkware(), {"door": "open"})
        self.assertEqual(native.events, ["open door", "forward", "observe"])
        self.assertNotIn("reset", vars(native))

    def test_benchmark_only_catalog_freezes_task_groups_and_scene_splits(self):
        adapter, config = load_config()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            registry = root / "robocasa/utils/dataset_registry.py"
            registry.parent.mkdir(parents=True)
            registry.write_text(
                "ATOMIC_TASK_DATASETS = OrderedDict(Atomic=dict(horizon=100))\n"
                "COMPOSITE_TASK_DATASETS = OrderedDict(Seen=dict(horizon=201), Unseen=dict(horizon=300), "
                "Later=dict(horizon=400))\n"
                "TARGET_TASKS = dict(atomic_seen=['Atomic'], composite_seen=['Seen'], composite_unseen=['Unseen'])\n"
                "LIFELONG_LEARNING_TASKS = dict(lifelong_learning_phase1=list(ATOMIC_TASK_DATASETS.keys()), "
                "lifelong_learning_phase2=['Seen'], lifelong_learning_phase3=['Later'], "
                "lifelong_learning_phase4=['Unseen'])\n"
            )
            assets = root / "assets"
            assets.mkdir()
            (assets / "synthetic.xml").write_text("<synthetic/>")
            argv = ["configure_robocasa365.py", "--robocasa-source", str(root), "--robosuite-source", str(root),
                    "--assets", str(assets), "--benchmark-image", "synthetic", "--benchmark-only"]
            references = {}
            for recipe, split, task_set, expected in (
                ("openpi", "pretrain", "atomic_seen", {"robocasa/Atomic": 150}),
                ("openpi", "pretrain", "composite_seen", {"robocasa/Seen": 302}),
                ("openpi", "target", "composite_seen", {"robocasa/Seen": 302}),
                ("gr00t", "pretrain", "composite_unseen", {"robocasa/Unseen": 300}),
                ("gr00t", "target", "target50", {"robocasa/Atomic": 100, "robocasa/Seen": 201, "robocasa/Unseen": 300}),
                ("diffusion-policy", "pretrain", "composite_seen", {"robocasa/Seen": 301}),
                ("gr00t", "pretrain", "all_tasks",
                 {"robocasa/Atomic": 100, "robocasa/Seen": 201, "robocasa/Unseen": 300, "robocasa/Later": 400}),
                ("gr00t", "pretrain", "lifelong_learning_phase3", {"robocasa/Later": 400}),
                ("gr00t", "pretrain", "lifelong_through_phase3",
                 {"robocasa/Atomic": 100, "robocasa/Seen": 201, "robocasa/Later": 400}),
            ):
                with self.subTest(recipe=recipe, split=split, task_set=task_set):
                    output = root / f"{recipe}-{split}-{task_set}"
                    args = argv + ["--recipe", recipe, "--split", split, "--task-set", task_set,
                                   "--output-dir", str(output)]
                    with patch.object(sys, "argv", args), contextlib.redirect_stdout(io.StringIO()), \
                            patch.object(config, "check_source"), \
                            patch.object(config, "image_id", return_value="sha256:" + "a" * 64):
                        config.main()
                    benchmark = json.loads((output / "benchmark.json").read_text())
                    reference = adapter.reference_profile(benchmark["config"])
                    self.assertEqual(reference, json.loads((output / "reference.json").read_text()))
                    self.assertEqual(reference["id"].split("/")[0] + "-native", benchmark["name"])
                    self.assertEqual(reference["environment"]["tasks"], list(expected))
                    self.assertEqual(reference["environment"]["horizons"], expected)
                    self.assertEqual(reference["environment"]["split"], split)
                    self.assertFalse((output / "policy.json").exists())
                    references[recipe, split, task_set] = reference
            self.assertEqual(references["openpi", "pretrain", "atomic_seen"]["id"], "robocasa365-atomic-seen/1")
            self.assertNotEqual(seed_asset(references["openpi", "pretrain", "composite_seen"], "robocasa/Seen"),
                                seed_asset(references["openpi", "target", "composite_seen"], "robocasa/Seen"))

    def test_default_atomic_references_preserve_legacy_profile_digests(self):
        _, config = load_config()
        profile = HERE / "profiles/robocasa365-atomic-seen.json"
        model = json.loads((HERE / "profiles/robocasa365-gr00t-n15.json").read_text())
        for recipe, expected in (
            ("openpi", "6409c5fafc75595deb9da862d73d51af7d31b67ddb118894cfd00d9557255454"),
            ("gr00t", "ca1d84b28df0a55257e81f063078edecdd326ae53591c4cdbc4a54197908f4e8"),
        ):
            with self.subTest(recipe=recipe), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                reference = json.loads(profile.read_text())
                if recipe == "gr00t":
                    config.groot_reference(reference, model)
                environment = reference["environment"]
                environment["assets"]["digest"] = "sha256:" + "0" * 64
                names = [task.split("/")[1] for task in environment["tasks"]]
                horizons = list(environment["horizons"].values())
                if recipe == "openpi":
                    horizons = [value * 2 // 3 for value in horizons]
                definitions = [f"{name}=dict(horizon={value})" for name, value in zip(names, horizons)]
                registry = root / "robocasa/utils/dataset_registry.py"
                registry.parent.mkdir(parents=True)
                registry.write_text(f"ATOMIC_TASK_DATASETS = OrderedDict({','.join(definitions)})\n"
                                    "COMPOSITE_TASK_DATASETS = OrderedDict()\n"
                                    f"TARGET_TASKS = dict(atomic_seen={names!r})\n")
                config.set_benchmark_scope(reference, root, "atomic_seen", "pretrain", recipe)
                self.assertEqual(digest(reference), "sha256:" + expected)
