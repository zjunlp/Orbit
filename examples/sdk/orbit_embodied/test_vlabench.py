"""Regression checks for native tracks, resets, and optional VLABench scores."""

import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from orbit_embodied.binding import check_distinct_resets, reset_seed, seed_asset
from orbit_embodied.vlabench import OPEN_TRACK, TRACKS, VLABenchBenchmark, track_catalog, track_path


class VLABenchCatalogTests(unittest.TestCase):
    def test_fixed_and_open_tracks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            configs = root / "VLABench/configs"
            fixed = root / "VLABench" / track_path(TRACKS[1])
            fixed.parent.mkdir(parents=True)
            fixed.write_text(json.dumps({"a": [{}] * 50, "b": [{}] * 10}))
            (configs / "__init__.py").write_text('name2config = {"family": ["b"]}')
            (configs / "task_config.json").write_text('{"family": {"evaluation": {"max_episode_length": 100}}}')
            tasks = root / "VLABench/tasks"
            tasks.mkdir()
            (tasks / "__init__.py").write_text("from VLABench.tasks.hierarchical_tasks import *")
            (tasks / "hierarchical_tasks.py").write_text("".join(
                f'@register.add_task("{name}")\nclass Task: pass\n' for name in ("a", "b", "held_out")
            ))
            self.assertEqual(track_catalog(root, TRACKS[1]), (["a", "b"], {"a": 200, "b": 100}, {"a": 50, "b": 10}))
            self.assertEqual(track_catalog(root, OPEN_TRACK)[0], ["a", "b", "held_out"])
            self.assertFalse(track_catalog(root, OPEN_TRACK)[2])

    def test_fixed_reset_and_open_seed_aliases(self):
        reference = {"environment": {"kind": "vlabench", "vlabenchEpisodeCounts": {"a": 10}}}
        sample = {"sampleId": "first", "taskId": "a", "initialStateId": "9",
                  "environmentSeed": 42, "policySeed": 0, "repetition": 0}
        self.assertEqual(reset_seed(sample, reference), 51)
        with self.assertRaises(ValueError):
            reset_seed(dict(sample, initialStateId="10"), reference)
        with self.assertRaises(ValueError):
            reset_seed(dict(sample, environmentSeed=43), reference)
        open_track = {"environment": {"kind": "vlabench"}}
        self.assertNotEqual(seed_asset(open_track, "a"), seed_asset(reference, "a"))
        with self.assertRaises(ValueError):
            check_distinct_resets([sample, dict(sample, sampleId="alias", initialStateId="8",
                                               environmentSeed=43)], open_track)


class TrackerScorers:
    def missing_tracker(self, name):
        error = AttributeError(name)
        error.name, error.obj = name, self
        raise error

    def get_task_progress(self):
        self.missing_tracker("target_is_grasped")

    def get_intention_score(self, threshold):
        self.missing_tracker("intention_distance")


class VLABenchScoreTests(unittest.TestCase):
    def result(self, task, success=True):
        reference = {"environment": {"horizons": {"synthetic": 1}}}
        benchmark = VLABenchBenchmark(reference, "synthetic")
        benchmark.success = success
        benchmark.env = SimpleNamespace(task=task, get_task_progress=task.get_task_progress,
                                        get_intention_score=task.get_intention_score)
        native = SimpleNamespace(LM4ManipBaseTask=TrackerScorers)
        with patch.dict(sys.modules, {"VLABench.tasks.dm_task": native}):
            return benchmark.result()

    def test_delegating_scorers_without_trackers_preserve_the_verdict(self):
        class DelegatingTask(TrackerScorers):
            def get_task_progress(self):
                return super().get_task_progress()

            def get_intention_score(self, threshold):
                return super().get_intention_score(threshold)

        for success in (True, False):
            with self.subTest(success=success):
                result = self.result(DelegatingTask(), success)
                self.assertIs(result["success"], success)
                self.assertEqual(result["metrics"], {})

    def test_condition_progress_survives_an_unavailable_intention_score(self):
        class ConditionTask(TrackerScorers):
            def get_task_progress(self):
                return 0

            def get_intention_score(self, threshold):
                if threshold != 0.1:
                    raise AssertionError("unexpected intention threshold")
                return float("nan")

        self.assertEqual(self.result(ConditionTask())["metrics"], {"progress_score": 0.0})

    def test_unrelated_attribute_error_is_not_suppressed(self):
        class BrokenTask(TrackerScorers):
            def get_task_progress(self):
                self.missing_tracker("conditions")

        with self.assertRaisesRegex(AttributeError, "conditions"):
            self.result(BrokenTask())
