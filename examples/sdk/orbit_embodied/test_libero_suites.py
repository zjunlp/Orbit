"""Synthetic provisioning checks; no model or native simulator fidelity is inferred."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from orbit_embodied import digest
from orbit_embodied.episode_trajectory import write_trajectory
from orbit_embodied.evidence import write_json
from orbit_embodied.libero_suites import HORIZONS, SUITES, LABELS, benchmark_name
from orbit_embodied.test_provision import configured_resources

HERE = Path(__file__).resolve().parents[2] / "bench-adapters/embodied"


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SuiteTests(unittest.TestCase):
    def test_libero_trajectory_excludes_settle_steps_and_marks_the_horizon(self):
        with tempfile.TemporaryDirectory() as temporary:
            episode = Path(temporary)
            control = {"phase": "control", "step": 0, "chunk": 0, "action": [0] * 7, "reward": 0,
                       "terminated": False, "state": {"eef_position": [1, 2, 3],
                                                     "eef_quaternion": [0, 0, 0, 1],
                                                     "gripper_position": [0.01, 0.02]}}
            rows = [{"phase": "settle", "step": 0}, control, {**control, "step": 1}]
            (episode / "actions.jsonl").write_text("\n".join(map(json.dumps, rows)))
            write_json(episode / "chunks/0.json", {"inferSeconds": 0.2})
            output = episode / "orbit-trajectory.json"
            write_trajectory(episode, output, {"success": False, "issues": []},
                             {"sample": {"taskId": "libero_90:synthetic"}}, kind="libero")
            trace = json.loads(output.read_text())
            self.assertEqual([row["time"] for row in trace["samples"]], [0, 0.1])
            self.assertEqual(trace["samples"][0]["proprio"], [1, 2, 3, 0, 0, 0, 1, 0.01, 0.02])
            self.assertTrue(trace["samples"][-1]["truncated"])
            self.assertFalse(trace["samples"][-1]["terminated"])
            self.assertEqual(trace["chunks"][0]["inferSeconds"], 0.2)

    def test_libero_90_registration_requires_only_a_simulator_audit(self):
        adapter = load("suite_native_adapter", "adapter.py")
        with patch.dict(sys.modules, {"adapter": adapter}):
            config = load("suite_native_config", "configure.py")
        reference = json.loads((HERE / "reference.json").read_text())
        image = "sha256:" + "a" * 64
        audit = {"profileDigest": digest(reference), "checks": [{"result": "passed"}],
                 "checkpoint": {"result": "not_run"},
                 "images": {"benchmark": {"result": "passed", "id": image}, "policy": {"result": "not_run"}}}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "audit.json"
            path.write_text(json.dumps(audit))
            output = root / "native"
            argv = ["configure.py", "--audit", str(path), "--reference-source", str(root),
                    "--output-dir", str(output), "--suite", "libero_90"]
            with patch.object(sys, "argv", argv):
                with self.assertRaisesRegex(ValueError, "checkpoint and policy image"):
                    config.main()
            with patch.object(sys, "argv", argv + ["--benchmark-only"]), contextlib.redirect_stdout(io.StringIO()):
                config.main()
            benchmark = json.loads((output / "benchmark.json").read_text())
            self.assertEqual(benchmark["name"], "libero-90-native")
            self.assertEqual(benchmark["config"]["suite"], "libero_90")
            self.assertEqual(benchmark["config"]["image"], image)
            self.assertFalse((output / "policy.json").exists())

    def test_pi05_and_groot_share_benchmark_conditions_and_use_matching_suite_weights(self):
        adapter = load("suite_adapter", "adapter.py")
        with patch.dict(sys.modules, {"adapter": adapter}):
            config = load("suite_pi05", "configure.py")
        reference = json.loads((HERE / "reference.json").read_text())
        for suite in SUITES:
            with self.subTest(suite=suite), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                groot = configured_resources(root, shared=True, profile="libero", suite=suite)
                audit = {"profileDigest": digest(reference), "checks": [], "checkpoint": {
                    "result": "passed", "checkpointDigest": "sha256:" + "b" * 64,
                    "normalizationDigest": "sha256:" + "c" * 64},
                    "images": {k: {"result": "passed", "id": "sha256:" + "a" * 64} for k in ("policy", "benchmark")}}
                path = root / "audit.json"
                path.write_text(json.dumps(audit))
                output = root / "pi05"
                argv = ["configure.py", "--audit", str(path), "--reference-source", str(root / "benchmark"),
                        "--output-dir", str(output), "--suite", suite, "--share-gpu"]
                with patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()):
                    config.main()
                benchmark = json.loads((output / "benchmark.json").read_text())
                policy = json.loads((output / "policy.json").read_text())
                self.assertEqual(policy["name"], "pi05-libero-shared")
                self.assertEqual(benchmark, groot["benchmark"])
                self.assertEqual(benchmark["name"], benchmark_name(suite))
                command = groot["policy"]["service"]["command"]
                self.assertEqual(command[command.index("--checkpoint") + 1], "/weights/" + suite)
                name = "groot-n17-libero" + ("" if suite == "libero_spatial" else "-" + LABELS[suite])
                self.assertEqual(groot["policy"]["name"], name)
                self.assertEqual(reference["horizons"][suite], HORIZONS[suite])

    def test_combined_oft_configuration_keeps_suite_assets_and_score_name(self):
        adapter = load("suite_oft_adapter", "adapter.py")
        with patch.dict(sys.modules, {"adapter": adapter}):
            groot = load("suite_groot", "configure_groot.py")
            with patch.dict(sys.modules, {"configure_groot": groot}):
                config = load("suite_oft", "configure_openvla.py")
        suite_titles = {"libero_spatial": "Spatial", "libero_object": "Object", "libero_goal": "Goal", "libero_10": "Long"}
        for suite in SUITES:
            with self.subTest(suite=suite), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                weights, output = root / "weights", root / "output"
                weights.mkdir()
                required = ["config.json", "preprocessor_config.json", "processor_config.json", "tokenizer_config.json",
                            "tokenizer.json", "tokenizer.model", "special_tokens_map.json", "model.safetensors",
                            "action_head--300000_checkpoint.pt", "proprio_projector--300000_checkpoint.pt"]
                for name in required:
                    (weights / name).write_text("synthetic inference fixture")
                (weights / "model.safetensors.index.json").write_text(json.dumps({"weight_map": {"synthetic": "model.safetensors"}}))
                (weights / "dataset_statistics.json").write_text(json.dumps({s + "_no_noops": {} for s in SUITES}))
                original = config.file_digest
                argv = ["configure_openvla.py", "--reference-source", str(root / "model-source"),
                        "--benchmark-source", str(root / "benchmark-source"), "--weights", str(weights), "--model", "combined",
                        "--suite", suite, "--policy-image", "synthetic", "--benchmark-image", "synthetic", "--output-dir", str(output)]
                model = json.loads((HERE / "profiles/openvla-model.json").read_text())
                reference = json.loads((HERE / "profiles/openvla-libero.json").read_text())
                audits = {root / "model-source" / n: d for n, d in model["files"].items()}
                audits.update({root / "benchmark-source" / n: d for n, d in reference["reference"]["files"].items()})

                def audited_digest(path):
                    return audits[path] if path in audits else original(path)

                with patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()), \
                        patch.object(config, "file_digest", side_effect=audited_digest), \
                        patch.object(config, "image_id", return_value="sha256:" + "a" * 64):
                    config.main()
                policy = json.loads((output / "policy.json").read_text())
                benchmark = json.loads((output / "benchmark.json").read_text())
                self.assertEqual(policy["normalizationKey"], suite + "_no_noops")
                command = policy["service"]["command"]
                self.assertEqual(command[command.index("--unnorm-key") + 1], policy["normalizationKey"])
                self.assertEqual(benchmark["name"], benchmark_name(suite, oft=True))
                self.assertEqual(policy["weights"]["dataset"], "openvla-oft-libero-combined")
                with patch.object(adapter, "file_digest", side_effect=audited_digest), \
                        patch.object(adapter, "catalog", return_value=[]):
                    listing = adapter.tasks({"benchmark": benchmark})
                self.assertEqual(listing["official"]["name"], f"LIBERO {suite_titles[suite]} success (OFT recipe)")
                with patch.object(sys, "argv", argv[:argv.index("--model") + 1] + ["spatial"] + argv[argv.index("--model") + 2:]), \
                        contextlib.redirect_stderr(io.StringIO()):
                    if suite != "libero_spatial":
                        with self.assertRaises(SystemExit):
                            config.main()


if __name__ == "__main__":
    unittest.main()
