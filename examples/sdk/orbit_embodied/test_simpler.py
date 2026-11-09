"""Finite SimplerEnv plans and legacy seed alias handling."""

import json
from pathlib import Path
import sys
import unittest

from orbit_embodied.binding import check_distinct_resets, reset_seed, seed_asset
from orbit_embodied.evidence import verify_simpler_termination
from orbit_embodied.simpler import grid_size, initial_state_count, rt_options, scene_at


ADAPTER = Path(__file__).resolve().parents[2] / "bench-adapters/embodied"
sys.path.insert(0, str(ADAPTER))
from configure_simpler import expand_sweeps

SWEEPS = json.loads((ADAPTER / "profiles/simpler-sweeps.json").read_text())


class SimplerTests(unittest.TestCase):
    def test_termination_advances_then_stops_on_the_final_subtask(self):
        native = [0] * 7
        initial = {"finalSubtask": False, "truncated": False}
        final = {"finalSubtask": True, "truncated": False}
        advance = {"action": native + [1], "nativeAction": native, "state": final, "terminated": False}
        stop = {**advance, "terminated": True}
        verify_simpler_termination([advance, stop], initial, 200)
        with self.assertRaisesRegex(ValueError, "policy termination protocol"):
            verify_simpler_termination([stop], initial, 200)
        with self.assertRaisesRegex(ValueError, "ended before the horizon"):
            verify_simpler_termination([advance], initial, 200)
        with self.assertRaisesRegex(ValueError, "policy termination protocol"):
            verify_simpler_termination([advance, stop, stop], initial, 200)

    def test_scene_indices_span_each_frozen_sweep(self):
        counts = {
            "google-visual-matching": (11, 1164),
            "google-variant-aggregation": (11, 1992),
            "widowx-visual-matching": (4, 96),
        }
        for profile, families in SWEEPS["profiles"].items():
            with self.subTest(profile=profile):
                scenes = expand_sweeps(families, profile.split("-")[0])
                env = {"simplerScenes": scenes}
                self.assertEqual((len(scenes), sum(initial_state_count(env, task) for task in scenes)), counts[profile])
                for task, settings in scenes.items():
                    start = 0
                    for setting in settings:
                        size = grid_size(setting)
                        self.assertGreater(size, 0)
                        self.assertEqual(scene_at(env, task, start), (setting, 0))
                        self.assertEqual(scene_at(env, task, start + size - 1), (setting, size - 1))
                        start += size
                    with self.assertRaisesRegex(ValueError, "frozen SimplerEnv scene grid"):
                        scene_at(env, task, start)

    def test_denoiser_override_only_changes_ray_traced_settings(self):
        self.assertEqual(rt_options({}, True), {})
        self.assertEqual(rt_options({"rtDenoiser": False}, False), {})
        self.assertEqual(rt_options({"rtDenoiser": False}, True), {"render_config": {"rt_use_denoiser": False}})

    def test_scene_and_random_seed_are_independent(self):
        task = "simpler_env_google/google_robot_move_near"
        legacy = {"environment": {}}
        reference = {"environment": {"simplerScenes": {task: [{}]}}}
        common = {"taskId": task, "policySeed": 0, "repetition": 0}
        first = {**common, "initialStateId": "1", "environmentSeed": 7, "sampleId": "a"}
        second = {**common, "initialStateId": "0", "environmentSeed": 8, "sampleId": "b"}
        self.assertEqual(reset_seed(first), 8)
        self.assertEqual(reset_seed(first, reference), 7)
        self.assertNotEqual(seed_asset(reference, task), seed_asset(legacy, task))
        check_distinct_resets([first, second], reference)
        with self.assertRaisesRegex(ValueError, "same native reset"):
            check_distinct_resets([first, second], legacy)
        with self.assertRaisesRegex(ValueError, "same native reset"):
            check_distinct_resets([first, {**first, "initialStateId": "01", "sampleId": "c"}], reference)


if __name__ == "__main__":
    unittest.main()
