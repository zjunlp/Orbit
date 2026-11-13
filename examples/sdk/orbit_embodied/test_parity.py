"""Comparator regression checks; real reference execution is a separate Orbit Run."""

import importlib.util
import json
from pathlib import Path
import unittest

import numpy as np


SOURCE = Path(__file__).resolve().parents[2] / "bench-adapters/embodied/benchmarks/libero/parity.py"
SPEC = importlib.util.spec_from_file_location("embodied_parity_tool", SOURCE)
parity = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(parity)


class ParityComparatorTests(unittest.TestCase):
    def test_paired_policy_keeps_streams_independent_and_compiled_weights_shared(self):
        spec = importlib.util.spec_from_file_location("paired_policy_tool", SOURCE.with_name("parity_policy.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        class SyntheticPolicy:
            def __init__(self):
                self.key = 0
                self.weights = object()
            def infer(self):
                self.key += 1
                return self.key
        original = SyntheticPolicy()
        reference, candidate = module.independent_policies(original)
        self.assertIs(reference.weights, candidate.weights)
        self.assertEqual((reference.infer(), reference.infer(), candidate.infer(), original.key), (1, 2, 1, 0))

    def test_native_numpy_boolean_counter_is_serializable_without_changing_the_score(self):
        values = {"task_id": 0, "episode_idx": 0, "task_episodes": 1, "task_successes": 0,
                  "total_episodes": 1, "total_successes": 0, "done": np.bool_(False)}
        result = json.loads(json.dumps(parity.episode_counters(values)))
        self.assertIs(result["done"], False)
        self.assertEqual((result["total_successes"], result["total_episodes"]), (0, 1))

    def test_detects_single_pixel_dtype_and_physics_changes(self):
        image = np.zeros((4, 4, 3), np.uint8)
        parity.equal({"image": image}, {"image": image.copy()}, "packet")
        changed = image.copy()
        changed[1, 2, 0] = 1
        for other in (changed, image.astype(np.float32)):
            with self.assertRaisesRegex(ValueError, "dtype, shape or values"):
                parity.equal({"image": image}, {"image": other}, "packet")
        left = parity.array_fingerprint(np.array([0., 1.]))
        right = parity.array_fingerprint(np.array([0., np.nextafter(1., 2.)]))
        with self.assertRaisesRegex(ValueError, "values differ"):
            parity.equal(left, right, "physics")

    def test_detects_trace_truncation_and_different_scores(self):
        with self.assertRaisesRegex(ValueError, "values differ"):
            parity.equal([{"done": False}, {"done": True}], [{"done": False}], "trace")
        with self.assertRaisesRegex(ValueError, "values differ"):
            parity.equal({"successes": 1, "episodes": 1}, {"successes": 0, "episodes": 1}, "score")


if __name__ == "__main__":
    unittest.main()
