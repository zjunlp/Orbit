"""Submission checks with an explicit catalog fixture and no simulator."""

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import adapter


class SubmissionTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        (Path(directory.name) / "src/vla_eval").mkdir(parents=True)
        self.config = {"benchmark": adapter.LIBERO_BENCHMARK}
        self.submission = {"tasks": ["libero_spatial:pick up the bowl"], "seeds": 50, "options": {}}
        self.req = {"benchmark": {"path": directory.name, "config": self.config},
                    "seedSubmission": self.submission}

    def test_check_shared_episode_limit_without_discovering_tasks_again(self):
        with patch.object(adapter, "benchmark_in_image") as discover:
            self.assertEqual(adapter.validate_seed_submission(self.req), {"ok": True})
            self.submission["seeds"] = 51
            with self.assertRaisesRegex(ValueError, "seed 51 has no episode"):
                adapter.validate_seed_submission(self.req)
        discover.assert_not_called()

    def test_check_robotwin_catalog_and_explicit_list(self):
        self.config.update(benchmark=adapter.ROBOTWIN_BENCHMARK, params='{"task_name": "adjust_bottle"}')
        self.submission["tasks"] = ["robotwin:adjust_bottle"]
        rows = [{"id": str(index), "suite": "robotwin", "name": "adjust_bottle", "identity": {"seed": seed}}
                for index, seed in enumerate((100001, 100002))]
        with patch.object(adapter, "benchmark_in_image", return_value=rows):
            for count, raw, message in (
                (2, None, None),
                (3, None, "only 2 scenes"),
                (2, "[100002]", "must match --seeds 2"),
                (1, "[100001,100002]", "must match --seeds 1"),
                (2, "[100001,100001]", "distinct native scene seeds"),
                (1, "[100000]", "distinct native scene seeds"),
                (1, "100002,", "must be a JSON array"),
                (1, "[100002]", None),
                (2, "[100002,100001]", None),
            ):
                with self.subTest(count=count, scene_seeds=raw):
                    self.submission.update(seeds=count, options={} if raw is None else {"sceneSeeds": raw})
                    if message is None:
                        self.assertEqual(adapter.validate_seed_submission(self.req), {"ok": True})
                    else:
                        with self.assertRaisesRegex(ValueError, message):
                            adapter.validate_seed_submission(self.req)


if __name__ == "__main__":
    unittest.main()
