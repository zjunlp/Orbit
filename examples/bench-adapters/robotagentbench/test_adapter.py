"""Explicit CPU fixtures; these checks do not simulate robot physics."""
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
import adapter
import prepare
import service
from verify import native_score


class AdapterTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        runtime = self.root / "runtime"
        runtime.mkdir()
        (runtime / "input.json").write_text('{"fixture":true}')
        image = "sha256:" + "a" * 64
        self.entry = {"image": image, "runtime": str(runtime), "nativeTask": "prepare_coffee",
            "files": {str(runtime / "input.json"): adapter.sha(runtime / "input.json")},
            "binds": [{"source": str(runtime), "target": str(runtime), "mode": "rw"}],
            "env": {}, "command": ["worker", "--output", "{output}"],
            "outputPrefix": str(runtime / "model_runs"), "deployment": {"name": "fixture", "image": image}}
        self.prepared = {"episodes": {"short/prepare_coffee": {"1": self.entry}},
                         "sourceFiles": {}, "revision": adapter.REVISION}
        self.req = {"benchmark": {}, "trial": {"id": "fixture-trial", "task": "short/prepare_coffee",
            "seed": 1, "method": {"agent": "empty", "name": "empty"}, "staging": str(self.root / "stage")}}
        self.addCleanup(patch.stopall)
        patch.object(adapter, "settings", return_value=(self.root, {"image": image}, self.prepared)).start()
        patch.object(adapter, "catalog", return_value={"short/prepare_coffee": set(range(1,31))}).start()

    def solve(self):
        return adapter.solve(self.req)["spec"]

    def test_isolation(self):
        spec = self.solve()
        self.assertEqual(spec["resources"]["gpus"], 0)
        self.assertEqual(spec["services"][0]["gpus"], 1)
        self.assertFalse(spec["network"])
        self.assertEqual(spec["services"][0]["networks"], ["robot"])
        self.assertEqual(spec["services"][0]["role"], "sim")
        self.assertNotIn("private.pem", json.dumps(spec["mounts"]))
        self.assertIn("/stage/runtime", spec["services"][0]["binds"][0]["source"])
        (self.root / "stage/runtime/input.json").write_text("trial mutation")
        self.assertEqual((self.root / "runtime/input.json").read_text(), '{"fixture":true}')

    def test_ordinal_and_changed_inputs_fail_before_staging(self):
        self.req["trial"]["seed"] = 0
        with self.assertRaisesRegex(ValueError, "ordinal"):
            self.solve()
        self.req["trial"]["seed"] = 1
        (self.root / "runtime/input.json").write_text("changed")
        with self.assertRaisesRegex(ValueError, "input changed"):
            self.solve()
        self.assertFalse((self.root / "stage").exists())

    def test_verify_restages_its_scripts_after_trial_cleanup(self):
        solve = self.solve()
        output = self.root / "solve"
        evidence = output / "services/environment/evidence"
        evidence.mkdir(parents=True)
        trial_stage = Path(self.req["trial"]["staging"])
        req = {**self.req, "solve": {"output": str(output), "run": {"spec": solve}}}
        first = adapter.verify(req)["spec"]
        shutil.rmtree(trial_stage)

        rescore = adapter.verify(req)["spec"]
        self.assertEqual(rescore, first)
        mount = next(mount for mount in rescore["mounts"] if mount["target"] == "/adapter")
        stage = Path(mount["source"])
        self.assertTrue((stage / "verify.py").is_file())
        self.assertTrue((stage / "evidence_helpers.py").is_file())
        self.assertEqual({path.name for path in stage.iterdir()}, {"verify.py", "evidence_helpers.py"})
        self.assertEqual(mount["mode"], "ro")
        self.assertIn({"source": str(evidence), "target": "/solve", "mode": "ro"}, rescore["mounts"])
        public = solve["services"][0]["env"][adapter.PUBLIC_KEY]
        self.assertEqual(rescore["env"][adapter.PUBLIC_KEY], public)

    def test_no_fabricated_scores(self):
        self.assertEqual(native_score({"status": "finished", "success": False,
            "scores": {"total": 3, "maximum": 8}}), (3/8, False))
        for bad in (
            {"status": "finished", "termination_reason": "client_closed", "success": False, "scores": {"total": 0, "maximum": 8}},
            {"status": "abandoned", "success": False, "scores": {"total": 0, "maximum": 8}},
            {"status": "finished", "success": True, "scores": {"total": 3}},
            {"status": "finished", "success": True, "scores": {"total": float("nan"), "maximum": 8}},
        ):
            with self.assertRaises((ValueError, KeyError)):
                native_score(bad)

    def test_score_cannot_cross_revision(self):
        result = {"valid": True, "score": 1, "success": True, "plan": {
            "revision": "other", "task": self.req["trial"]["task"], "method": self.req["trial"]["method"],
            "ordinal": 1, "trial": "fixture-trial"}}
        output = self.root / "verify"
        output.mkdir()
        (output / "result.json").write_text(json.dumps(result))
        req = {**self.req, "verify": {"output": str(output)}}
        self.assertTrue(adapter.score(req)["invalid"])

    def test_native_namespace_only_translates_mounts_and_environment(self):
        argv = ["docker", "run", "--rm", "--network", "none", "--gpus", "all",
                "--env", "VK_DRIVER_FILES=/native.json", "--mount", "type=bind,src=/prepared,dst=/job,readonly",
                "sha256:fixture", "native"]
        binds, env = prepare.bindings(argv, "sha256:fixture")
        self.assertEqual(binds, [{"source": "/prepared", "target": "/job", "mode": "ro"}])
        self.assertEqual(env, {"VK_DRIVER_FILES": "/native.json"})
        argv[2:2] = ["--privileged"]
        with self.assertRaises(ValueError):
            prepare.bindings(argv, "sha256:fixture")

    def test_closed_service_blocks_motion(self):
        class FixtureBridge:
            instructions = "public native contract"
            def dispatch(self, call_id, name, args):
                return {"success": True, "contentItems": []}
        robot = service.RobotService(FixtureBridge(), {})
        self.assertEqual(robot.call("observe", {}, "one")["contentItems"][0]["text"], "public native contract")
        robot.closed = True
        with self.assertRaises(RuntimeError):
            robot.call("execute_actions", {}, "two")


if __name__ == "__main__":
    unittest.main()
