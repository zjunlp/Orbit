"""VLA-Arena regression checks with synthetic evidence and language fixtures."""

import copy
import importlib.util
import json
from pathlib import Path
import random
import sys
import tempfile
import unittest
from unittest.mock import patch

from orbit_embodied.vla_arena import SETTLE_ACTION, arena_cost, selected_instruction, verify_arena_evidence


class VLAArenaTests(unittest.TestCase):
    def test_hazard_scaling_and_safety_gate_are_checked_from_controls(self):
        task = "safety_hazard_avoidance/l0/test"
        reference = {"environment": {"catalog": {task: {
            "suite": "safety_hazard_avoidance", "level": 0, "name": "test", "instruction": "pick a cup",
        }}, "horizons": {task: 2}, "safety": True}}
        sample = {"taskId": task, "initialStateId": "0", "environmentSeed": 7}
        controls = [
            {"nativeDone": False, "terminated": False, "nativeSuccess": False, "state": {
                "stepCost": 100, "timeoutCost": 0, "safetyCost": 100,
                "costReported": True, "taskSuccess": False, "instruction": "pick a cup",
            }},
            {"nativeDone": True, "terminated": True, "nativeSuccess": False, "state": {
                "stepCost": 120, "timeoutCost": 0, "safetyCost": 11,
                "costReported": True, "taskSuccess": True, "instruction": "pick a cup",
            }},
        ]
        native = {"suite": "safety_hazard_avoidance", "level": 0, "task": "test",
                  "taskSuccess": True, "safetyCost": 11, "success": False, "instruction": "pick a cup"}
        result = {"success": False, "native": native}
        verify_arena_evidence(reference, sample, controls, result, [{"action": SETTLE_ACTION}])
        altered = copy.deepcopy(controls)
        altered[-1]["state"]["safetyCost"] = 220
        with self.assertRaisesRegex(ValueError, "safety cost"):
            verify_arena_evidence(reference, sample, altered, result)
        with self.assertRaisesRegex(ValueError, "settling actions"):
            verify_arena_evidence(reference, sample, controls, result, [{"action": [0.0] * 7}])
        self.assertEqual(arena_cost("safety_hazard_avoidance", 220, True, False), 220)

        controls[-1].update(nativeDone=False, terminated=False)
        controls[-1]["state"].update(taskSuccess=False, timeoutCost=20, safetyCost=12)
        native.update(taskSuccess=False, safetyCost=12)
        verify_arena_evidence(reference, sample, controls, result)
        with self.assertRaisesRegex(ValueError, "control evidence"):
            verify_arena_evidence(reference, sample, controls[:1], result)

    def test_frozen_language_selection_preserves_the_native_draw(self):
        script = Path(__file__).resolve().parents[2] / "bench-adapters/embodied/configure_vla_arena.py"
        spec = importlib.util.spec_from_file_location("configure_vla_arena", script)
        configure = importlib.util.module_from_spec(spec)
        with patch.object(sys, "path", [str(script.parent), *sys.path]):
            spec.loader.exec_module(configure)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "replacements.json"
            rows = [{"original": "pick_a_cup", "modified": "lift_a_cup", "ignored": "x" * 65536},
                    {"original": "pick_a_cup", "modified": "grasp_a_mug"}]
            path.write_text(json.dumps(rows), encoding="utf-8")
            catalog = {"cup": {"instruction": "pick a cup", "initialStateCount": 3},
                       "bowl": {"instruction": "lift a bowl", "initialStateCount": 3}}
            replacements = configure.freeze_replacements(path, catalog)
        self.assertEqual(set(replacements), {"cup"})
        environment = {"catalog": catalog, "languageReplacements": replacements}
        for index in range(3):
            rng = random.Random(7 + index)
            rng.random()
            expected = rng.choice(["lift a cup", "grasp a mug"])
            self.assertEqual(selected_instruction(environment, "cup", {"initialStateId": str(index)}), expected)
        self.assertEqual(selected_instruction(environment, "bowl", {"initialStateId": "0"}), "lift a bowl")
