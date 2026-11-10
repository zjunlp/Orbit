"""Checks for the pinned Colosseum V2 stopping and perturbation contract."""

import importlib.util
from pathlib import Path
from subprocess import CompletedProcess
import sys
import unittest
from unittest.mock import patch

import numpy as np

from orbit_embodied.colosseum import ColosseumBenchmark


class ColosseumTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = Path(__file__).resolve().parents[2] / "bench-adapters/embodied/configure_colosseum.py"
        spec = importlib.util.spec_from_file_location("configure_colosseum", script)
        cls.configure = importlib.util.module_from_spec(spec)
        with patch.object(sys, "path", [str(script.parent), *sys.path]):
            spec.loader.exec_module(cls.configure)

    def test_catalog_preserves_disabled_cells_and_missing_assets(self):
        catalog = {"morphologies": {"single-arm": ["RaiseCube-v1", "OpenCabinet-v1"]},
                   "tasks": {
                       "RaiseCube-v1": {"horizon": 92, "instruction": "raise", "disabled": ["RO_SIZE"], "assets": []},
                       "OpenCabinet-v1": {"horizon": 491, "instruction": "open", "disabled": [], "assets": ["cabinet"]},
                   }, "missingAssets": ["cabinet"], "distractorAssets": []}
        _, reference = self.configure.reference_for(catalog, "single-arm", "RO_SIZE", "digest", {})
        self.assertEqual(reference["environment"]["tasks"], ["RaiseCube-v1", "OpenCabinet-v1"])
        self.assertEqual(reference["environment"]["horizons"]["RaiseCube-v1"], 92)
        reasons = reference["environment"]["unsupported"]
        self.assertIn("disabled", reasons["RaiseCube-v1"])
        self.assertIn("cabinet", reasons["OpenCabinet-v1"])
        _, combined = self.configure.reference_for(catalog, "single-arm", "ALL", "digest", {})
        self.assertNotIn("RaiseCube-v1", combined["environment"]["unsupported"])

    def test_prepare_assets_continues_past_a_failed_download(self):
        root = Path("/assets")
        still_missing = {"missingAssets": ["partnet_mobility/1027"]}
        with patch.object(self.configure.subprocess, "run",
                          return_value=CompletedProcess([], 0)) as download, patch.object(
                              self.configure, "native_catalog", return_value=still_missing) as catalog:
            actual = self.configure.prepare_assets("test-image", root, ["partnet_mobility/1027", "ycb"])
        self.assertEqual(actual, still_missing)
        self.assertEqual([call.args[0][-2] for call in download.call_args_list], ["partnet_mobility/1027", "ycb"])
        catalog.assert_called_once_with("test-image", root)

    def test_success_once_does_not_stop_the_official_episode(self):
        reference = {"environment": {"tasks": ["task"], "horizon": 2},
                     "parameters": {"controlHz": 20},
                     "benchmarkProfile": {"action": {"shape": [7]}}}
        benchmark = ColosseumBenchmark(reference, "task")
        benchmark.config["perturbation"] = "NONE"
        benchmark.observation = lambda raw: raw
        env = type("SyntheticEnv", (), {"step": lambda self, action: next(self.steps)})()
        env.steps = iter([({}, 1, True, False, {"success": True}), ({}, 0, False, True, {"success": False})])
        benchmark.env = env
        first = benchmark.step(np.zeros(7))
        self.assertTrue(first.native_done)
        self.assertFalse(first.terminated)
        second = benchmark.step(np.zeros(7))
        self.assertTrue(second.terminated)
        self.assertFalse(second.success)
        self.assertTrue(benchmark.result()["successOnce"])
        self.assertFalse(benchmark.result()["successAtEnd"])
