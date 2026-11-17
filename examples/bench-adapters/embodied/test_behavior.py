"""Synthetic CPU evidence and metadata fixtures, not native simulation."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from orbit_embodied.behavior1k import asset_digest, native_instance, profile, verify_behavior


class BehaviorTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.reference = {"environment": {"tasks": ["activity"]}}
        self.sample = {"taskId": "activity", "environmentSeed": 0, "initialStateId": "0"}

    def test_public_instances_are_not_random_seeds(self):
        self.assertEqual(native_instance(self.reference, self.sample), 301)
        self.assertEqual(native_instance(self.reference, {**self.sample, "initialStateId": "19"}), 320)
        for changes in ({"environmentSeed": 1}, {"initialStateId": "20"}, {"taskId": "unknown"}):
            with self.assertRaises(ValueError):
                native_instance(self.reference, {**self.sample, **changes})

    def test_query_watchdog_covers_the_complete_call_and_never_retries(self):
        import time
        from orbit_embodied.behavior1k import bounded_query
        calls = []
        def delayed():
            calls.append(True)
            time.sleep(0.1)
        with self.assertRaises(TimeoutError):
            bounded_query(delayed, 0.01, TimeoutError)
        self.assertEqual(calls, [True])
        self.assertEqual(bounded_query(lambda: 42, 0.1, TimeoutError), 42)

    def test_native_profile(self):
        semantic = profile()
        self.assertEqual(semantic["action"]["shape"], [23])
        self.assertEqual(len(semantic["action"]["order"]), 23)
        self.assertEqual(len(semantic["observations"]["robot_r1::proprio"]["order"]), 61)
        self.assertEqual(semantic["observations"]["robot_r1::cam_rel_poses"]["order"][0], "left_wrist.x")
        images = [row for row in semantic["observations"].values() if row.get("semantic") == "rgba"]
        self.assertEqual(len(images), 3)
        self.assertTrue(all(row["shape"] == [224, 224, 4] for row in images))

    def test_fingerprint_excludes_key_but_detects_asset_changes(self):
        from orbit_embodied.behavior1k import ASSET_DIRS
        for name in ASSET_DIRS:
            (self.root / name).mkdir()
            (self.root / name / "fixture").write_text(name)
        first = asset_digest(self.root)
        (self.root / "omnigibson.key").write_text("synthetic test key")
        self.assertEqual(asset_digest(self.root), first)
        (self.root / ASSET_DIRS[0] / "fixture").write_text("changed")
        self.assertNotEqual(asset_digest(self.root), first)

    def test_verification_rejects_native_report_or_raw_action_changes(self):
        import numpy as np
        chunks = self.root / "chunks"
        chunks.mkdir()
        raw = np.ones((1, 23), dtype=np.float64) / 3
        action = raw.astype(np.float32)
        np.save(chunks / "0.npy", action)
        np.save(chunks / "0.raw.npy", raw)
        report = {"task": "activity", "instance_id": 301, "rollout_id": 0, "steps": 1,
                  "success": False, "q_score": {"final": 0.5}}
        (self.root / "behavior-report.json").write_text(json.dumps(report))
        controls = [{"chunk": 0, "nativeSuccess": False, "terminated": True, "nativeDone": True,
                     "action": action[0].tolist(), "nativeAction": action[0].tolist(),
                     "state": {"instanceId": 301, "nativeStep": 1, "success": False}}]
        result = {"success": False, "native": {"report": report, "score": 0.5, "instanceId": 301}}
        verify_behavior(self.reference, self.sample, controls, result, self.root)
        changed = copy.deepcopy(result)
        changed["native"]["report"]["q_score"]["final"] = 1
        with self.assertRaises(ValueError):
            verify_behavior(self.reference, self.sample, controls, changed, self.root)
        np.save(chunks / "0.raw.npy", np.zeros((1, 23)))
        with self.assertRaises(ValueError):
            verify_behavior(self.reference, self.sample, controls, result, self.root)


if __name__ == "__main__":
    unittest.main()
