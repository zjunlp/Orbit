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

from orbit_embodied.binding import digest, seed_asset
from orbit_embodied.robocasa import RoboCasaBenchmark

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
        for groot, expected in (
            (False, "6409c5fafc75595deb9da862d73d51af7d31b67ddb118894cfd00d9557255454"),
            (True, "ca1d84b28df0a55257e81f063078edecdd326ae53591c4cdbc4a54197908f4e8"),
        ):
            with self.subTest(groot=groot), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                reference = json.loads(profile.read_text())
                if groot:
                    config.groot_reference(reference, model)
                environment = reference["environment"]
                environment["assets"]["digest"] = "sha256:" + "0" * 64
                names = [task.split("/")[1] for task in environment["tasks"]]
                horizons = list(environment["horizons"].values())
                if not groot:
                    horizons = [value * 2 // 3 for value in horizons]
                definitions = [f"{name}=dict(horizon={value})" for name, value in zip(names, horizons)]
                registry = root / "robocasa/utils/dataset_registry.py"
                registry.parent.mkdir(parents=True)
                registry.write_text(f"ATOMIC_TASK_DATASETS = OrderedDict({','.join(definitions)})\n"
                                    "COMPOSITE_TASK_DATASETS = OrderedDict()\n"
                                    f"TARGET_TASKS = dict(atomic_seen={names!r})\n")
                config.set_benchmark_scope(reference, root, "atomic_seen", "pretrain", groot)
                self.assertEqual(digest(reference), "sha256:" + expected)
