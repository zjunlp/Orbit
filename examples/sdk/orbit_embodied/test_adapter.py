"""Native adapter planning with synthetic registrations; no containers are executed."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from orbit_embodied import resolve_binding
from orbit_embodied.implementation import archive_implementation, verify_implementation


ROOT = Path(__file__).resolve().parents[3]
ADAPTER = ROOT / "examples/bench-adapters/embodied/adapter.py"
SPEC = importlib.util.spec_from_file_location("native_embodied_adapter", ADAPTER)
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)


class AdapterPlanningTests(unittest.TestCase):
    def test_native_plan_keeps_model_service_in_orbit_and_preserves_runtime_imports(self):
        reference = json.loads((ADAPTER.parent / "reference.json").read_text())
        binding = resolve_binding(reference["benchmarkProfile"], reference["policyProfile"], reference["observationMap"])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = {"image": "sha256:" + "a" * 64, "implementationDigest": adapter.implementation_digest()}
            request = {"benchmark": {"config": config}, "trial": {
                "id": "synthetic-trial", "task": "synthetic:task", "sampleRef": "synthetic-sample",
                "sample": {"sampleId": "synthetic-sample"}, "binding": binding,
                "method": {"policySnapshot": {"profile": reference["policyProfile"]}},
                "staging": str(root / "staging")}}
            with patch.object(adapter, "settings", return_value=(root, config, reference)):
                solve = adapter.solve(request)["spec"]
            self.assertNotIn("services", solve)
            self.assertIn("/app/third_party/libero", solve["env"]["PYTHONPATH"])
            self.assertIn("/app/packages/openpi-client/src", solve["env"]["PYTHONPATH"])
            self.assertEqual(solve["env"]["MUJOCO_GL"], solve["env"]["PYOPENGL_PLATFORM"])
            staged = json.loads((root / "staging/request.json").read_text())
            self.assertEqual(staged["binding"], binding)
            self.assertTrue(staged["episodeId"].startswith("synthetic-trial."))
            archive = root / "implementation"
            measured = archive_implementation(root / "staging", archive)
            self.assertEqual(measured, config["implementationDigest"])
            verify_implementation(archive, measured)
            (archive / "run.py").write_text("# altered driver\n")
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                verify_implementation(archive, measured)
            request["solve"] = {"output": str(root / "solve-output")}
            verifier = adapter.verify(request)["spec"]
            self.assertEqual(verifier["resources"]["gpus"], 0)
            self.assertNotIn("services", verifier)
            self.assertFalse(verifier["network"])


if __name__ == "__main__":
    unittest.main()
