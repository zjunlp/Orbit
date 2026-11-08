"""Native adapter planning with synthetic registrations; no containers are executed."""

import importlib.util
import copy
import json
from pathlib import Path
import shutil
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch

from orbit_embodied import digest, resolve_binding
from orbit_embodied.evidence import write_json
from orbit_embodied.implementation import archive_implementation, verify_implementation


ROOT = Path(__file__).resolve().parents[3]
ADAPTER = ROOT / "examples/bench-adapters/embodied/adapter.py"
SPEC = importlib.util.spec_from_file_location("native_embodied_adapter", ADAPTER)
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)


class AdapterPlanningTests(unittest.TestCase):
    def batch_request(self, root):
        request = self.request(root)
        first = request["trial"]
        second = copy.deepcopy(first)
        second.update(id="synthetic-second", staging=str(root / "second-staging"))
        content = {key: value for key, value in second["sample"].items() if key != "sampleId"}
        content["initialStateId"] = "1"
        second["sample"] = {**content, "sampleId": digest(content)}
        second["sampleRef"] = second["sample"]["sampleId"]
        content = {"version": 1, "id": "synthetic-batch", "attemptId": "attempt", "method": "synthetic-policy",
                   "randomness": "service", "members": [
                       {"trialId": trial["id"], "sampleRef": trial["sampleRef"], "episodeId": trial["id"] + ".attempt"}
                       for trial in (first, second)]}
        plan = {**content, "digest": digest(content)}
        for index, trial in enumerate((first, second)):
            trial["batch"] = {"plan": plan, "index": index}
        request["batch"] = {"plan": plan, "trials": [first, second]}
        spec = request["solve"]["run"]["spec"]
        spec["params"]["batchDigest"] = plan["digest"]
        spec["tags"].update(embodied_evidence="3", execution_batch=plan["id"], batch_attempt=plan["attemptId"])
        return request

    def test_versioned_evidence_cannot_skip_the_solve_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            staging = adapter.stage({"trial": {"staging": str(root / "stage")}})
            spec = importlib.util.spec_from_file_location("staged_run", staging / "run.py")
            run = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(run)
            episode = root / "solve/episode"
            write_json(episode / "contract.json", {"identity": {"implementationDigest": "sha256:" + "0" * 64}})
            expected = {"sample": {"sampleId": "synthetic"}, "evidenceVersion": 2,
                        "verifierDigest": archive_implementation(staging, root / "probe")}
            write_json(root / "expected.json", expected)
            with self.assertRaisesRegex(ValueError, "lacks its implementation archive"):
                run.main(["verify", str(episode), str(root / "out/verified.json"), str(root / "expected.json")])

    def test_fixed_batch_has_one_run_and_independent_episode_verification(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self.batch_request(root)
            reference = json.loads(request["benchmark"]["config"]["reference"])
            with patch.object(adapter, "settings", return_value=(root, request["benchmark"]["config"], reference)):
                reply = adapter.solve(request)["spec"]
            self.assertEqual(reply["command"][1], "batch")
            self.assertEqual(reply["timeoutMin"], 40)
            self.assertEqual(reply["tags"]["embodied_evidence"], "3")
            payload = json.loads((root / "staging/batch-request.json").read_text())
            self.assertEqual([item["sample"]["initialStateId"] for item in payload["episodes"]], ["0", "1"])
            request["trial"] = request["batch"]["trials"][1]
            request["trial"]["id"] = "consolidated-second"
            verify = adapter.verify(request)["spec"]
            self.assertIn("/solve/episodes/synthetic-second.attempt", verify["command"])
            expected = json.loads((root / "second-staging/verify-request.json").read_text())
            self.assertEqual(expected["executionTrialId"], "synthetic-second")
            self.assertEqual(expected["batch"]["index"], 1)
            self.assertEqual(verify["resources"]["gpus"], 0)
            self.assertNotIn("services", verify)

    def test_batch_verification_rejects_other_episode_or_attempt(self):
        with tempfile.TemporaryDirectory() as temporary:
            request = self.batch_request(Path(temporary))
            for field in ("batch_attempt", "execution_batch"):
                changed = copy.deepcopy(request)
                changed["solve"]["run"]["spec"]["tags"][field] = "other"
                with self.subTest(field=field), self.assertRaisesRegex(ValueError, "batch attempt"):
                    adapter.verify(changed)
            request["trial"]["batch"]["index"] = 1
            with self.assertRaisesRegex(ValueError, "batch attempt"):
                adapter.verify(request)

    def request(self, root):
        reference = json.loads((ADAPTER.parent / "reference.json").read_text())
        content = {"taskId": "synthetic:task", "benchmarkProfile": reference["id"],
                   "initialStateId": "0", "initialStateDigest": "sha256:" + "a" * 64,
                   "environmentSeed": 7, "policySeed": 0, "repetition": 0}
        sample = {**content, "sampleId": digest(content)}
        return {"benchmark": {"config": {"image": "sha256:" + "a" * 64,
                "reference": json.dumps(reference), "profileDigest": digest(reference),
                "implementationDigest": adapter.implementation_digest()}}, "trial": {
            "id": "synthetic-trial", "task": content["taskId"], "sampleRef": sample["sampleId"],
            "sample": sample,
            "binding": resolve_binding(reference["benchmarkProfile"], reference["policyProfile"], reference["observationMap"]),
            "method": {"name": "synthetic-policy", "policySnapshot": {"profile": reference["policyProfile"]}},
            "staging": str(root / "staging")},
            "solve": {"output": str(root / "solve-output"), "run": {"id": "source-run", "spec": {
                "params": {"sampleRef": sample["sampleId"], "task": content["taskId"],
                           "method": "synthetic-policy", "phase": "solve"},
                "tags": {"trial": "synthetic-trial", "embodied_evidence": "2"}}}}}

    def test_native_plan_keeps_model_service_in_orbit_and_preserves_runtime_imports(self):
        reference = json.loads((ADAPTER.parent / "reference.json").read_text())
        binding = resolve_binding(reference["benchmarkProfile"], reference["policyProfile"], reference["observationMap"])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self.request(root)
            config = request["benchmark"]["config"]
            with patch.object(adapter, "settings", return_value=(root, config, reference)):
                solve = adapter.solve(request)["spec"]
            self.assertNotIn("services", solve)
            self.assertEqual(solve["tags"]["embodied_evidence"], "2")
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
            verifier = adapter.verify(request)["spec"]
            self.assertEqual(verifier["resources"]["gpus"], 0)
            self.assertNotIn("services", verifier)
            self.assertFalse(verifier["network"])

    def test_second_model_profile_reuses_the_same_libero_benchmark(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self.request(root)
            reference = json.loads(request["benchmark"]["config"]["reference"])
            profile = request["trial"]["method"]["policySnapshot"]["profile"]
            profile["id"] = "groot-libero-input/1"
            request["trial"]["binding"] = resolve_binding(reference["benchmarkProfile"], profile, reference["observationMap"])
            with patch.object(adapter, "settings", return_value=(root, request["benchmark"]["config"], reference)):
                adapter.solve(request)
            staged = json.loads((root / "staging/request.json").read_text())
            self.assertEqual(staged["reference"], reference)
            self.assertEqual(staged["binding"]["policyProfile"]["id"], "groot-libero-input/1")

    def test_verifier_uses_frozen_context_and_original_execution_trial(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self.request(root)
            request["trial"]["id"] = "consolidated-trial"
            tags = request["solve"]["run"]["spec"]["tags"]
            tags.update(trial="consolidated-trial", source_trial="intermediate-trial", execution_trial="synthetic-trial")
            request["benchmark"]["config"]["implementationDigest"] = "sha256:" + "b" * 64
            adapter.verify(request)
            expected = json.loads((root / "staging/verify-request.json").read_text())
            self.assertEqual(expected["solveRunId"], "source-run")
            self.assertEqual(expected["executionTrialId"], "synthetic-trial")
            self.assertEqual(expected["sample"], request["trial"]["sample"])
            self.assertEqual(expected["binding"], request["trial"]["binding"])
            self.assertEqual(expected["solveImplementationDigest"], "sha256:" + "b" * 64)
            del tags["execution_trial"]
            self.assertEqual(adapter.verification_expectation(request)["executionTrialId"], "intermediate-trial")
            for key in ("sampleRef", "task", "method", "phase"):
                changed = copy.deepcopy(request)
                changed["solve"]["run"]["spec"]["params"][key] = "other"
                with self.subTest(key=key), self.assertRaisesRegex(ValueError, "solve Run differs"):
                    adapter.verify(changed)
            del request["trial"]["binding"]
            with self.assertRaisesRegex(ValueError, "missing frozen"):
                adapter.verify(request)

    def test_score_rejects_verifier_output_for_another_trial_or_source_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self.request(root)
            request["verify"] = {"output": str(root / "verify-output")}
            expected = adapter.verification_expectation(request)
            result = {"sampleRef": request["trial"]["sampleRef"], "episodeId": "synthetic-trial.attempt",
                      "valid": True, "success": True, "issues": []}
            write_json(root / "solve-output/episode/native-result.json", result)
            write_json(root / "verify-output/verified.json", result)
            verification = {"sampleRef": result["sampleRef"], "episodeId": result["episodeId"],
                            "solveRunId": "source-run", "trialId": "synthetic-trial",
                            "implementationDigest": expected["verifierDigest"], "expectationDigest": digest(expected)}
            write_json(root / "verify-output/verification.json", verification)
            self.assertFalse(adapter.score(request)["invalid"])
            for key in ("solveRunId", "trialId", "expectationDigest"):
                write_json(root / "verify-output/verification.json", {**verification, key: "other"})
                with self.subTest(key=key):
                    self.assertTrue(adapter.score(request)["invalid"])

    def test_host_verifier_planning_requires_only_the_standard_library(self):
        with tempfile.TemporaryDirectory() as temporary:
            request = {**self.request(Path(temporary)), "protocol": 1, "op": "verify"}
            completed = subprocess.run([sys.executable, "-S", "-B", str(ADAPTER), "verify"],
                                       input=json.dumps(request), text=True, capture_output=True)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(json.loads(completed.stdout)["spec"]["resources"]["gpus"], 0)

    def test_default_reference_agrees_across_phases_and_rejects_profile_drift(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self.request(root)
            request["benchmark"]["path"] = str(root)
            reference = json.loads(request["benchmark"]["config"].pop("reference"))
            reference["reference"]["files"] = {}
            here = root / "synthetic-adapter"
            here.mkdir()
            for name in ("run.py", "adapter.py"):
                shutil.copy2(ADAPTER.parent / name, here / name)
            write_json(here / "reference.json", reference)
            config = request["benchmark"]["config"]
            config["profileDigest"] = digest(reference)
            with patch.object(adapter, "HERE", here), patch.object(adapter, "catalog", return_value=[]):
                config["implementationDigest"] = adapter.implementation_digest()
                adapter.tasks(request)
                adapter.solve(request)
                adapter.verify(request)
                solve = json.loads((root / "staging/request.json").read_text())
                verify = json.loads((root / "staging/verify-request.json").read_text())
                self.assertEqual(solve["reference"], reference)
                self.assertEqual(verify["reference"], reference)
                changed = copy.deepcopy(reference)
                changed["parameters"]["settleSteps"] += 1
                write_json(here / "reference.json", changed)
                for phase in (adapter.tasks, adapter.solve, adapter.verify):
                    with self.subTest(phase=phase.__name__), self.assertRaisesRegex(ValueError, "profileDigest"):
                        phase(request)
                config["reference"] = json.dumps(reference)
                adapter.verify(request)


if __name__ == "__main__":
    unittest.main()
