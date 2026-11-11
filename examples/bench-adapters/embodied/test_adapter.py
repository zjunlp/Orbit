"""Native adapter planning with synthetic registrations; no containers are executed."""

import importlib.util
import copy
import json
from itertools import product
from pathlib import Path
import shutil
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "examples/sdk"))

from orbit_embodied import digest, resolve_binding  # noqa: E402
from orbit_embodied.binding import (  # noqa: E402
    check_distinct_resets,
    reference_horizon,
    reset_seed,
    seed_asset,
)
from orbit_embodied.evidence import write_json  # noqa: E402
from orbit_embodied.implementation import archive_implementation, verify_implementation  # noqa: E402


ADAPTER = Path(__file__).resolve().parent / "adapter.py"
SPEC = importlib.util.spec_from_file_location("native_embodied_adapter", ADAPTER)
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)


class AdapterPlanningTests(unittest.TestCase):
    def test_native_runtime_images_require_matching_manifest_and_entrypoint(self):
        with patch.object(sys, "path", [str(ADAPTER.parent), *sys.path]):
            import native_runtime

        mt100 = native_runtime.runtime_manifest("rlbench-mt100", native_runtime.rlbench_sources(False))
        rvt = native_runtime.runtime_manifest("rlbench-rvt18", native_runtime.rlbench_sources(True))
        casa = native_runtime.runtime_manifest("robocasa-v02", native_runtime.robocasa_sources())
        image_id = "sha256:" + "a" * 64
        for expected, actual, entrypoint in (
            (mt100, mt100, mt100["entrypoint"]),
            (rvt, rvt, rvt["entrypoint"]),
            (casa, casa, casa["entrypoint"]),
            (mt100, casa, casa["entrypoint"]),
            (mt100, rvt, rvt["entrypoint"]),
            (casa, None, casa["entrypoint"]),
            (rvt, rvt, ["python"]),
            (mt100, {**mt100, "coppeliasim": "wrong"}, mt100["entrypoint"]),
        ):
            labels = {native_runtime.MANIFEST_LABEL: json.dumps(actual)} if actual else {}
            config = {"Labels": labels, "Entrypoint": entrypoint}
            output = json.dumps([{"Id": image_id, "Config": config}])
            with self.subTest(kind=expected["kind"], actual=actual, entrypoint=entrypoint):
                with patch.object(native_runtime.subprocess, "check_output", return_value=output):
                    if expected == actual and entrypoint == expected["entrypoint"]:
                        self.assertEqual(native_runtime.require_image("tag", expected), image_id)
                    else:
                        with self.assertRaisesRegex(ValueError, "expected the pinned"):
                            native_runtime.require_image("tag", expected)

    def test_vima_policy_image_requires_the_packaged_sdk_manifest(self):
        with patch.object(sys, "path", [str(ADAPTER.parent / "benchmarks"), *sys.path]):
            import configure_manipulation
            import native_runtime

        with tempfile.TemporaryDirectory() as temporary, patch.object(configure_manipulation, "SDK", Path(temporary)):
            sdk = Path(temporary) / "orbit_embodied"
            sdk.mkdir()
            wire = sdk / "wire.py"
            wire.write_text("original")
            test = sdk / "test_wire.py"
            test.write_text("test")
            sources = {}
            policy = configure_manipulation.manifest("vima-bench", sources, "policy")
            simulator = configure_manipulation.manifest("vima-bench", sources, "simulator")
            self.assertEqual(policy["sdk"], {"wire.py": adapter.file_digest(wire)})
            self.assertNotIn("sdk", simulator)
            image_id = "sha256:" + "a" * 64
            image = json.dumps([{"Id": image_id, "Config": {
                "Labels": {native_runtime.MANIFEST_LABEL: json.dumps(policy)},
                "Entrypoint": policy["entrypoint"],
            }}])
            with patch.object(native_runtime.subprocess, "check_output", return_value=image):
                self.assertEqual(native_runtime.require_image("tag", policy), image_id)
                test.write_text("changed test")
                unchanged = configure_manipulation.manifest("vima-bench", sources, "policy")
                self.assertEqual(native_runtime.require_image("tag", unchanged), image_id)
                for filename, content in (("wire.py", "modified"), ("codec.py", "added"), ("wire.py", None)):
                    with self.subTest(filename=filename, content=content):
                        path = sdk / filename
                        if content is None:
                            path.unlink()
                        else:
                            path.write_text(content)
                        expected = configure_manipulation.manifest("vima-bench", sources, "policy")
                        with self.assertRaisesRegex(ValueError, "matching build manifest"):
                            native_runtime.require_image("tag", expected)
                        self.assertEqual(configure_manipulation.manifest("vima-bench", sources, "simulator"), simulator)
                        if path == wire:
                            wire.write_text("original")
                        else:
                            path.unlink()

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

    def test_solve_checks_the_mounted_simulator_assets_once_before_execution(self):
        for kind, operation in product(("libero-plus", "vlabench"), ("solve", "batch")):
            with self.subTest(kind=kind, operation=operation), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                staging = adapter.stage({"trial": {"staging": str(root / "stage")}})
                spec = importlib.util.spec_from_file_location("staged_run", staging / "run.py")
                run = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(run)
                assets = root / "assets"
                assets.mkdir()
                asset = assets / "texture"
                asset.write_bytes(b"frozen texture")
                checksum = run.tree_digest(assets)
                episode = {"reference": {"environment": {"kind": kind, "assets": {
                    "target": str(assets), "digest": checksum,
                }}}, "implementationDigest": "driver"}
                payload = episode if operation == "solve" else {"plan": {}, "episodes": [episode, episode]}
                request = root / "request.json"
                write_json(request, payload)
                def prepare_only(request, destination, *, prepare):
                    prepare()

                def batch_prepare_only(plan, episodes, output, execute):
                    for episode in episodes:
                        execute(episode, output)

                with patch.dict(run.SIMULATOR_ASSET_ROOTS, {kind: str(assets)}), \
                        patch.object(run, "archive_implementation", return_value="driver"), \
                        patch.object(run, "tree_digest", wraps=run.tree_digest) as measure, \
                        patch.object(run, "execute_episode", side_effect=prepare_only), \
                        patch("orbit_embodied.batch.run_batch", side_effect=batch_prepare_only):
                    argv = [operation, str(request), str(root / "output")]
                    run.main(argv)
                    measure.assert_called_once_with(str(assets))
                    asset.write_bytes(b"changed texture")
                    with self.assertRaisesRegex(ValueError, "mounted simulator asset digest mismatch"):
                        run.main(argv)
                    self.assertEqual(measure.call_count, 2)

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

    def test_verifier_accepts_a_libero_reference_without_environment(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self.request(root)
            adapter.verify(request)
            staging = Path(request["trial"]["staging"])
            spec = importlib.util.spec_from_file_location("staged_run", staging / "run.py")
            run = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(run)
            solve = Path(request["solve"]["output"])
            episode = solve / "episode"
            fingerprint = archive_implementation(staging, solve / "implementation")
            write_json(episode / "contract.json", {"identity": {"implementationDigest": fingerprint,
                                                                  "implementationArchive": True}})
            result = {"episodeId": "synthetic-trial.attempt", "valid": True, "success": True}
            write_json(episode / "native-result.json", result)
            output = root / "out/verified.json"
            with patch.object(run, "verify_episode", return_value=result):
                run.main(["verify", str(episode), str(output), str(staging / "verify-request.json")])
            self.assertEqual(json.loads(output.read_text()), result)
            self.assertTrue(output.with_name("verification.json").is_file())
            self.assertFalse(output.with_name("orbit-trajectory.json").exists())

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

    def test_diffusion_solve_requires_native_done_evidence_with_or_without_batch(self):
        for batched in (False, True):
            with self.subTest(batched=batched), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                request = self.batch_request(root) if batched else self.request(root)
                config = request["benchmark"]["config"]
                reference = json.loads(config["reference"])
                reference["environment"] = {"protocol": "diffusion-policy"}
                config.update(reference=json.dumps(reference), profileDigest=digest(reference))
                with patch.object(adapter, "settings", return_value=(root, config, reference)):
                    solve = adapter.solve(request)["spec"]
                self.assertEqual(solve["tags"]["embodied_evidence"], "4")
                request["solve"]["run"]["spec"]["tags"]["embodied_evidence"] = "4"
                expected = adapter.verification_expectation(request)
                self.assertEqual(expected["evidenceVersion"], 4)
                self.assertEqual("batch" in expected, batched)

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

    def test_fixed_native_catalog_keeps_seed_and_state_index_independent(self):
        asset = "sha256:" + "b" * 64
        reference = {"environment": {"kind": "vla-arena", "environmentSeed": 7,
                                     "initialStateCounts": {"task": 2},
                                     "initialStateDigests": {"task": asset}}}
        first = {"taskId": "task", "initialStateId": "0", "environmentSeed": 7, "policySeed": 0,
                 "repetition": 0, "sampleId": "first"}
        second = {**first, "initialStateId": "1", "sampleId": "second"}
        self.assertEqual(seed_asset(reference, "task"), asset)
        self.assertEqual(reset_seed(second, reference), 7)
        check_distinct_resets([first, second], reference)
        for invalid in ({**second, "initialStateId": "2"}, {**second, "environmentSeed": 8}):
            with self.assertRaisesRegex(ValueError, "frozen initial-state"):
                reset_seed(invalid, reference)
        with self.assertRaisesRegex(ValueError, "same native reset"):
            check_distinct_resets([first, {**first, "sampleId": "aliased"}], reference)

    def test_robocasa_plans_task_horizons_and_mounts_assets_only_for_solve(self):
        reference = json.loads((ADAPTER.parent / "profiles/robocasa365-atomic-seen.json").read_text())
        assets = reference["environment"]["assets"]
        assets["digest"] = "sha256:" + "b" * 64
        task = "robocasa/OpenDrawer"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self.request(root)
            config = request["benchmark"]["config"]
            config.update(reference=json.dumps(reference), profileDigest=digest(reference))
            trial = request["trial"]
            trial["task"] = task
            content = {key: value for key, value in trial["sample"].items() if key != "sampleId"}
            content.update(taskId=task, benchmarkProfile=reference["id"], initialStateDigest=seed_asset(reference, task))
            trial["sample"] = {**content, "sampleId": digest(content)}
            trial["sampleRef"] = trial["sample"]["sampleId"]
            profile = {**reference["benchmarkProfile"], "id": "synthetic-robocasa-policy/1"}
            trial["method"]["policySnapshot"]["profile"] = profile
            trial["binding"] = resolve_binding(reference["benchmarkProfile"], profile, reference["observationMap"])
            request["solve"]["run"]["spec"]["params"].update(task=task, sampleRef=trial["sampleRef"])
            with patch.object(adapter, "settings", return_value=(root, config, reference)):
                catalog = adapter.tasks(request)
                solve = adapter.solve(request)["spec"]
            self.assertEqual(len(catalog["tasks"]), 18)
            self.assertEqual(catalog["official"]["unit"], "task")
            self.assertEqual(reference_horizon(reference, task), 750)
            self.assertEqual(reference_horizon(reference, "robocasa/OpenStandMixerHead"), 450)
            self.assertEqual(solve["mounts"][-1], {"dataset": assets["dataset"], "target": assets["target"], "mode": "ro"})
            self.assertFalse(any("dataset" in mount for mount in adapter.verify(request)["spec"]["mounts"]))

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

    def test_calvin_reports_raw_completed_subtasks_as_its_primary_metric(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self.request(root)
            config = request["benchmark"]["config"]
            reference = json.loads(config["reference"])
            reference["environment"] = {"kind": "calvin", "tasks": [request["trial"]["task"]],
                                        "catalog": {"sequences": [[0, ["one", "two", "three", "four", "five"]]]}}
            config.update(reference=json.dumps(reference), profileDigest=digest(reference))
            with patch.object(adapter, "settings", return_value=(root, config, reference)):
                catalog = adapter.tasks(request)
            self.assertEqual(catalog["official"]["metric"], "completed_subtasks")
            primary = [metric for metric in catalog["metrics"] if metric.get("primary")]
            self.assertEqual([(metric["name"], metric["range"]) for metric in primary],
                             [("completed_subtasks", [0, 5])])

            request["verify"] = {"output": str(root / "verify-output")}
            expected = adapter.verification_expectation(request)
            result = {"sampleRef": request["trial"]["sampleRef"], "episodeId": "synthetic-trial.attempt",
                      "valid": True, "success": False, "issues": [], "native": {"completedSubtasks": 2}}
            write_json(root / "solve-output/episode/native-result.json", result)
            write_json(root / "verify-output/verified.json", result)
            write_json(root / "verify-output/verification.json",
                       {"sampleRef": result["sampleRef"], "episodeId": result["episodeId"],
                        "solveRunId": expected["solveRunId"], "trialId": expected["trialId"],
                        "implementationDigest": expected["verifierDigest"], "expectationDigest": digest(expected)})
            outcome = adapter.score(request)
            self.assertFalse(outcome["invalid"])
            self.assertEqual(outcome["metrics"], {"completed_subtasks": 2, "success_at_1": 1, "success_at_2": 1,
                                                   "success_at_3": 0, "success_at_4": 0, "success_at_5": 0})

    def test_arena_reports_success_and_safety_cost_by_level(self):
        for suite, level, gate, success in (
            ("safety_hazard_avoidance", 0, True, False),
            ("safety_hazard_avoidance", 1, False, True),
            ("long_horizon", 2, False, True),
        ):
            with self.subTest(suite=suite, level=level, gate=gate), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                request = self.request(root)
                request["benchmark"]["path"] = str(root)
                request["verify"] = {"output": str(root / "verify-output")}
                config = request["benchmark"]["config"]
                reference = json.loads(config["reference"])
                reference["reference"]["files"] = {}
                task = request["trial"]["task"]
                levels = {task if difficulty == level else f"task-l{difficulty}": {"level": difficulty}
                          for difficulty in range(3)}
                reference["environment"] = {"kind": "vla-arena", "suite": suite, "safety": gate,
                                            "tasks": list(levels), "catalog": levels}
                config.update(reference=json.dumps(reference), profileDigest=digest(reference))

                safety_suite = suite.startswith("safety_")
                declared = [f"success_l{difficulty}" for difficulty in range(3)]
                if safety_suite:
                    declared.extend(["safety_cost", *(f"safety_cost_l{difficulty}" for difficulty in range(3))])
                metrics = adapter.tasks(request)["metrics"]
                self.assertEqual([metric["name"] for metric in metrics], declared)
                self.assertTrue(all(metric["higherIsBetter"] is False for metric in metrics[3:]))

                expected = adapter.verification_expectation(request)
                result = {"sampleRef": request["trial"]["sampleRef"], "episodeId": "synthetic-trial.attempt",
                          "valid": True, "success": success, "issues": [],
                          "native": {"taskSuccess": True, "safetyCost": 12.5}}
                write_json(root / "solve-output/episode/native-result.json", result)
                write_json(root / "verify-output/verified.json", result)
                write_json(root / "verify-output/verification.json",
                           {"sampleRef": result["sampleRef"], "episodeId": result["episodeId"],
                            "solveRunId": expected["solveRunId"], "trialId": expected["trialId"],
                            "implementationDigest": expected["verifierDigest"], "expectationDigest": digest(expected)})
                outcome = adapter.score(request)
                self.assertFalse(outcome["invalid"])
                self.assertEqual(outcome["score"], int(success))
                expected_metrics = {f"success_l{level}": int(success)}
                if safety_suite:
                    expected_metrics.update({"safety_cost": 12.5, f"safety_cost_l{level}": 12.5})
                self.assertEqual(outcome["metrics"], expected_metrics)

    def test_native_registration_help_requires_only_the_standard_library(self):
        for script in ("colosseum-v2/configure_colosseum.py", "libero-pro/configure_libero_pro.py"):
            with self.subTest(script=script):
                completed = subprocess.run([sys.executable, "-S", "-B", str(ADAPTER.parent / "benchmarks" / script), "--help"],
                                           text=True, capture_output=True)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertIn("--benchmark-image", completed.stdout)

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
