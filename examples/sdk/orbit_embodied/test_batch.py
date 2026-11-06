"""Explicit synthetic episodes validate ordering, cancellation and sealed-prefix behavior."""

import copy
import json
from pathlib import Path
import signal
import unittest

from orbit_embodied import digest, run_episode, verify_episode
from orbit_embodied.batch import run_batch
from orbit_embodied import test_core as synthetic
from orbit_embodied.test_core import SyntheticBenchmark, SyntheticPolicy


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.core = synthetic.CoreTests()
        self.core.setUp()
        self.output = Path(self.core.temporary.name) / "batch"
        members, episodes = [], []
        for index in range(3):
            content = {key: value for key, value in self.core.sample.items() if key != "sampleId"}
            content["initialStateId"] = str(index)
            sample = {**content, "sampleId": digest(content)}
            members.append({"trialId": "trial." + str(index), "sampleRef": sample["sampleId"],
                            "episodeId": "trial." + str(index) + ".attempt"})
            episodes.append({"trialId": members[-1]["trialId"], "episodeId": members[-1]["episodeId"], "sample": sample})
        content = {"version": 1, "id": "batch", "attemptId": "attempt", "method": "synthetic",
                   "randomness": "service", "members": members}
        self.plan = {**content, "digest": digest(content)}
        self.episodes = [{**request, "batch": {"plan": self.plan, "index": index}}
                         for index, request in enumerate(episodes)]

    def tearDown(self):
        self.core.tearDown()

    def execute(self, request, directory, cancelled, *, invalid=False, benchmark=None):
        identity = {"execution": {"runId": "run", "trialId": request["trialId"]},
                    "batch": request["batch"], "reference": {}, "policy": {}, "implementationDigest": "synthetic"}
        return run_episode(benchmark or SyntheticBenchmark(success_at=2), SyntheticPolicy(invalid=invalid),
                           request["sample"], self.core.binding, directory, request["episodeId"], identity,
                           cancelled=cancelled, seal_before_media=True)

    def expected(self, index):
        request = self.episodes[index]
        return {"sample": request["sample"], "binding": self.core.binding, "reference": {}, "policy": {},
                "solveImplementationDigest": "synthetic", "executionTrialId": request["trialId"],
                "solveRunId": "run", "evidenceVersion": 3, "batch": request["batch"]}

    def verify(self, index, expected=None):
        request = self.episodes[index]
        return verify_episode(self.output / "episodes" / request["episodeId"],
                              request["sample"]["sampleId"], request["episodeId"], expected or self.expected(index))

    def test_ordered_members_keep_independent_state_and_frozen_attempts(self):
        visited = []
        def execute(request, directory, cancelled):
            visited.append(request["sample"]["initialStateId"])
            return self.execute(request, directory, cancelled)
        run_batch(self.plan, self.episodes, self.output, execute)
        self.assertEqual(visited, ["0", "1", "2"])
        self.assertEqual([self.verify(index)["steps"] for index in range(3)], [2, 2, 2])
        changed = copy.deepcopy(self.expected(1))
        changed["batch"]["plan"]["attemptId"] = "different"
        with self.assertRaisesRegex(ValueError, "batch"):
            self.verify(1, changed)

    def test_later_invalid_episode_preserves_completed_prefix_and_stops(self):
        def execute(request, directory, cancelled):
            return self.execute(request, directory, cancelled, invalid=request["batch"]["index"] == 1)
        with self.assertRaisesRegex(RuntimeError, "invalid episode"):
            run_batch(self.plan, self.episodes, self.output, execute)
        self.assertTrue(self.verify(0)["valid"])
        self.assertFalse(self.verify(1)["valid"])
        summary = json.loads((self.output / "batch-result.json").read_text())
        self.assertEqual(summary["states"], ["completed", "invalid", "not_started"])

    def test_cancel_stops_current_and_unstarted_episodes_without_sealing_them(self):
        def execute(request, directory, cancelled):
            if request["batch"]["index"] == 1:
                signal.raise_signal(signal.SIGTERM)
            return self.execute(request, directory, cancelled)
        run_batch(self.plan, self.episodes, self.output, execute)
        self.assertTrue(self.verify(0)["valid"])
        self.assertFalse((self.output / "episodes" / self.episodes[1]["episodeId"] / "evidence-manifest.json").exists())
        summary = json.loads((self.output / "batch-result.json").read_text())
        self.assertEqual(summary["states"], ["completed", "interrupted", "not_started"])
        self.assertTrue(summary["cancelled"])

    def test_result_is_sealed_before_optional_video_and_remains_unchanged_on_media_failure(self):
        test = self
        class OptionalMedia(SyntheticBenchmark):
            def finish_video(self):
                test.assertTrue(test.verify(0)["valid"])
                raise RuntimeError("synthetic optional encoder failure")
        request = self.episodes[0]
        result = self.execute(request, self.output / "episodes" / request["episodeId"], lambda: False,
                              benchmark=OptionalMedia(success_at=2))
        self.assertEqual(result, self.verify(0))
        self.assertTrue((self.output / "episodes" / request["episodeId"] / "media-status.json").exists())

    def test_changed_or_reordered_plan_is_rejected_before_any_episode(self):
        changed = copy.deepcopy(self.episodes)
        changed.reverse()
        with self.assertRaisesRegex(ValueError, "membership"):
            run_batch(self.plan, changed, self.output, lambda *_: self.fail("must not execute"))
        self.assertFalse(self.output.exists())
