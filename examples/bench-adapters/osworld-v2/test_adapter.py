"""Explicit file/SDK fixtures, not VM integration checks."""
import ast
import datetime
import hashlib
import importlib.util
import json
import logging
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
import zipfile

import adapter
import evidence
import runtime

try:
    import docker
    from docker.models.containers import ContainerCollection
except ImportError:
    docker = None


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.task = self.root / "task_001.py"
        self.task.write_text('class Task(BaseTask):\n    proxy = False\n    platform = "linux"\n')
        self.expected = {"size": self.task.stat().st_size, "sha256": evidence.digest(self.task)}

    def test_release_task_hash_and_service_constraints(self):
        self.assertIsNone(adapter.task_conditions(self.task, self.expected))
        self.task.write_text('class Task(BaseTask):\n    proxy = True\n')
        self.assertIn("differs", adapter.task_conditions(self.task, self.expected))
        expected = {"size": self.task.stat().st_size, "sha256": evidence.digest(self.task)}
        self.assertIn("proxy", adapter.task_conditions(self.task, expected))
        self.assertIn("missing", adapter.task_conditions(self.root / "missing.py", expected))

    def args(self):
        return {"environment": {"CPU_CORES": "4", "RAM_SIZE": "4G", "DISK_SIZE": "32G"},
                "devices": ["/dev/kvm"], "cap_add": ["NET_ADMIN"],
                "volumes": {str(self.root / "disk.qcow2"): {"bind": "/System.qcow2", "mode": "ro"}},
                "ports": {8006: 18006, 5000: 15000, 9222: 19222, 8080: 18080}, "detach": True}

    def test_sdk_create_and_run_are_owned_and_single(self):
        class Collection:
            def create(self, image, command=None, **kwargs): return kwargs
            def run(self, image, **kwargs): return self.create(image, **kwargs)
        guard = runtime.OwnedCreation("fixture-run", "image@sha256:fixture", self.root / "disk.qcow2", {"memGB": 8})
        guard.install(Collection)
        result = Collection().run("image@sha256:fixture", **self.args())
        self.assertEqual(result["labels"]["orbit.parent"], "fixture-run")
        self.assertEqual(result["nano_cpus"], 4_000_000_000)
        self.assertEqual(result["mem_limit"], 6 * 1024 ** 3)
        self.assertTrue(all(value[0] == "127.0.0.1" for value in result["ports"].values()))
        with self.assertRaisesRegex(ValueError, "Only one"):
            Collection().create("image@sha256:fixture", **self.args())

    @unittest.skipUnless(docker is not None and docker.__version__ == "7.1.0", "requires original Docker SDK 7.1.0")
    def test_original_sdk_run_create_contract_with_explicit_api_fixture(self):
        client = MagicMock()
        client.api._version = "1.45"
        client.api.create_container.return_value = {"Id": "fixture-native-sdk-id"}
        client.api.inspect_container.return_value = {"Id": "fixture-native-sdk-id", "Name": "fixture", "Config": {}, "State": {"Running": True}}
        guard = runtime.OwnedCreation("sdk-contract-fixture", "fixed-image", self.root / "disk.qcow2", {"memGB": 8})
        original = ContainerCollection.create
        self.addCleanup(setattr, ContainerCollection, "create", original)
        guard.install(ContainerCollection)
        collection = ContainerCollection(client=client)
        collection.run("fixed-image", **self.args())
        client.api.start.assert_called_once_with("fixture-native-sdk-id")
        created = client.api.create_container.call_args.kwargs
        host = created["host_config"]
        self.assertEqual(created["labels"]["orbit.parent"], "sdk-contract-fixture")
        self.assertEqual(host["NanoCpus"], 4_000_000_000)
        self.assertEqual(host["Memory"], 6 * 1024 ** 3)
        self.assertTrue(all(bind[0]["HostIp"] == "127.0.0.1" for bind in host["PortBindings"].values()))
        with self.assertRaises(ValueError): collection.run("fixed-image", detach=True)

    @unittest.skipUnless(os.environ.get("OSWORLD_CHECKOUT"), "requires pinned original checkout for native runner contract")
    def test_original_single_runner_with_explicit_environment_fixture(self):
        source = Path(os.environ["OSWORLD_CHECKOUT"])
        hashes = {"lib_run_single.py": "ea6287894aaefb504c6419aa3307b69f0f4b95cbd7fecf67c9c70a25003d1e5e",
                  "lib_results_logger.py": "0f14ee44dd88f1e1db54bb908e0be00a6cd55798dba07702d78dfcb773a565cb"}
        for name, sha in hashes.items():
            self.assertEqual(evidence.digest(source / name), sha, "Original runner source changed")
        spec = importlib.util.spec_from_file_location("native_results_logger", source / "lib_results_logger.py")
        results_logger = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(results_logger)
        # Execute original functions unchanged, excluding unrelated optional imports.
        names = {"run_single_example", "setup_logger", "_get_task_phases", "_configure_agent_for_task",
                 "_parse_checkpoint_steps", "_persist_evaluation_result", "GuestMemoryTracer"}
        tree = ast.parse((source / "lib_run_single.py").read_text())
        tree.body = [node for node in tree.body if getattr(node, "name", None) in names]
        fake_time = SimpleNamespace(sleep=MagicMock(), perf_counter=MagicMock(return_value=1.0))
        scope = {"datetime": datetime, "json": json, "logging": logging, "os": os, "time": fake_time,
                 "logger": logging.getLogger("explicit-native-runner-fixture"),
                 "log_task_completion": results_logger.log_task_completion}
        exec(compile(tree, str(source / "lib_run_single.py"), "exec"), scope)
        env = MagicMock()
        env._get_obs.return_value = {"screenshot": b"explicit initial image fixture"}
        env.step.return_value = ({"screenshot": b"explicit resulting image fixture"}, 0, True, {})
        env.evaluate.return_value = {"score": 1.0, "reason": "explicit evaluator fixture"}
        scores = []
        args = runtime.native_args({"method": {"agent": "empty"}}, self.root)
        scope["run_single_example"](runtime.EmptyAgent(), env, {"id": "fixture-task"}, 15,
                                    "fixture goal", args, str(self.root), scores)
        self.assertEqual(scores, [1.0])
        self.assertEqual(json.loads((self.root / "summary/results.json").read_text())[0]["score"], 1.0)
        env.reset.assert_called_once()
        env.step.assert_called_once_with("DONE", 0.0)
        env.evaluate.assert_called_once()
        fake_time.sleep.assert_called_once_with(60)
        for handler in logging.getLogger("desktopenv.example.fixture-task").handlers[:]:
            handler.close()
            logging.getLogger("desktopenv.example.fixture-task").removeHandler(handler)

    def test_sdk_refuses_alternate_image_device_or_mount(self):
        for field, value in (("devices", []), ("volumes", {}), ("network_mode", "host")):
            guard = runtime.OwnedCreation("fixture-run", "image", self.root / "disk.qcow2", {"memGB": 8})
            args = self.args()
            args[field] = value
            with self.assertRaises(ValueError): guard.arguments("image", **args)
        guard = runtime.OwnedCreation("fixture-run", "image", self.root / "disk.qcow2", {"memGB": 8})
        with self.assertRaises(ValueError): guard.arguments("other-image", **self.args())

    def test_metric_error_observer_keeps_missing_output_as_method_failure(self):
        observer = runtime.EvaluatorErrors()
        observer.emit(logging.LogRecord("desktopenv.env", logging.ERROR, "", 1, "File not found!", (), None))
        self.assertFalse(observer.failed)
        observer.emit(logging.LogRecord("desktopenv.env", logging.ERROR, "", 1, "Metric metric failed with error: broken evaluator", (), None))
        self.assertTrue(observer.failed)
        with self.assertRaises(ValueError): runtime.valid_reward({"reason": "no score"})
        with self.assertRaises(ValueError): runtime.valid_reward(float("nan"))
        self.assertEqual(runtime.valid_reward({"score": 0}), 0)

    def test_vm_archive_requires_original_digest(self):
        archive = self.root / "fixture.zip"
        with zipfile.ZipFile(archive, "w") as output:
            output.writestr("../original.qcow2", b"explicit disk fixture")
        plan = {"paths": {"archive": str(archive)}, "image": {"artifact_sha256": "sha256:" + evidence.digest(archive)}}
        vm = runtime.prepare_vm(plan, self.root / "staging")
        self.assertEqual(vm.read_bytes(), b"explicit disk fixture")
        self.assertEqual(vm.parent, self.root / "staging/vm")
        plan["image"]["artifact_sha256"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(ValueError, "checksum"):
            runtime.prepare_vm(plan, self.root / "bad")

    def test_known_secret_redaction_preserves_binary_artifacts(self):
        text = self.root / "native.log"
        image = self.root / "frame.png"
        text.write_text("provider error: fixture-secret-value")
        image.write_bytes(b"fixture-secret-value")
        evidence.redact_text_artifacts(self.root, ["fixture-secret-value"])
        self.assertNotIn("fixture-secret-value", text.read_text())
        self.assertEqual(image.read_bytes(), b"fixture-secret-value")

    def test_gui_view_groups_native_actions_without_extra_frames(self):
        rows = [{"action": "click(1,2)", "screenshot_file": None},
                {"action": "DONE", "screenshot_file": "last.png", "done": True, "reward": 0}]
        view = evidence.trajectory_review("fixture goal", rows)
        self.assertEqual(len(view["steps"]), 2)
        self.assertEqual(view["steps"][0]["screenshot"], "native/initial.png")
        self.assertEqual(view["steps"][1]["action"], "click(1,2)\nDONE")
        self.assertTrue(view["steps"][1]["terminated"])

    def saved(self):
        native = self.root / "native"
        native.mkdir()
        (native / "step.png").write_bytes(b"explicit screenshot fixture")
        plan = {"schema": 1, "source": adapter.COMMIT, "release": adapter.RELEASE,
                "task": "task_001", "seed": 1, "method": {"name": "empty", "agent": "empty"}, "max_steps": 3}
        evidence.write(self.root / "plan.json", plan)
        (native / "result.txt").write_text("0.0\n")
        (native / "traj.jsonl").write_text('{"step_num":1,"action":"DONE","done":true,"screenshot_file":"step.png"}\n')
        (native / "initial.png").write_bytes(b"explicit initial screenshot fixture")
        evidence.write(native / "initial-goal.json", "fixture goal")
        evidence.write(self.root / "trajectory-review.json", evidence.trajectory_review("fixture goal", [json.loads((native / "traj.jsonl").read_text())]))
        files = ["trajectory-review.json", "plan.json", "native/result.txt", "native/traj.jsonl", "native/step.png", "native/initial.png", "native/initial-goal.json"]
        result = {"status": "completed", "score": 0, "steps": 1, "terminated": True, "resets": 1, "evaluations": 1,
                  "sha256": {name: evidence.digest(self.root / name) for name in files}}
        evidence.write(self.root / "result.json", result)
        return plan, result

    def test_saved_score_and_missing_screenshot(self):
        self.saved()
        self.assertEqual(evidence.validate(self.root)["score"], 0)
        (self.root / "native/step.png").write_bytes(b"changed fixture")
        with self.assertRaises(ValueError): evidence.validate(self.root)

    def test_failure_is_invalid_not_zero(self):
        plan, _ = self.saved()
        evidence.write(self.root / "result.json", {"status": "error", "failure": "env_start"})
        request = {"trial": plan, "solve": {"output": str(self.root)}, "verify": {"output": str(self.root)}}
        result = adapter.score(request)
        self.assertTrue(result["invalid"])
        self.assertIsNone(result["score"])
        self.assertEqual(result["failure"], "env_start")

    def test_catalog_keeps_missing_release_tasks_unsupported(self):
        release = {"tasks": {"commit": "tasks"}, "assets": {"commit": "assets"},
                   "provider_images": {"docker": {"ubuntu": {"runtime_image": "image"}}}}
        request = {"benchmark": {"path": str(self.root), "config": {"tasksDir": str(self.root)}}}
        with patch.object(adapter, "settings", return_value=(self.root, request["benchmark"]["config"], release,
                          {"task_001.py": self.expected, "task_002.py": self.expected}, 50)), \
             patch.object(adapter, "prerequisites", return_value=["KVM unavailable"]):
            rows = adapter.tasks(request)["tasks"]
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(not row["supported"] and "KVM unavailable" in row["reason"] for row in rows))


if __name__ == "__main__": unittest.main()
