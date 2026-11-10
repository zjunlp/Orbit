"""Protocol unit tests with explicit synthetic task fixtures; not native calibration."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("clbench_adapter", Path(__file__).with_name("adapter.py"))
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.data = self.root / "data"
        subset = self.data / "subsets/stage0_smoke"
        for name, value in {
            "ready_l2_tasks_with_images.json": [{"task_id": "learn_a"}, {"task_id": "learn_b"}],
            "ready_l4_tasks_with_images.json": [{"task_id": "target"}],
            "learning_plan.json": {"targets": [{"target_task_id": "target", "learning_task_ids": ["learn_b", "learn_a"]}]},
        }.items():
            adapter.write(subset / name, value)
        for task in ("learn_a", "learn_b", "target"):
            directory = self.data / "input/merged/tasks" / task
            adapter.write(directory / "input" / f"{task}_atomic_expanded_graph.json", {"synthetic": True})
            adapter.write(directory / "task_image_manifest.json", {"states": []})
        adapter.write(self.data / "input/merged/option_bank_highlevel_v2_smoke.jsonl", {})
        self.req = {"benchmark": {"path": str(self.root), "config": {}}, "trial": {
            "task": "in_context_l4/target", "staging": str(self.root / "staging"), "seed": 5,
            "hostNetwork": False, "method": {"agent": "claude-code"}}}
        self.mock = patch.object(adapter, "settings", return_value=(self.root, self.data, "stage0_smoke"))
        self.mock.start()
        self.images = patch.object(adapter, "image_files", return_value=[])
        self.images.start()

    def tearDown(self):
        self.images.stop()
        self.mock.stop()
        self.temp.cleanup()

    def test_official_sequence_order_is_one_trial(self):
        _, _, plan = adapter.plan_for(self.req)
        self.assertEqual(plan["task_ids"], ["learn_b", "learn_a", "target"])
        self.assertEqual(plan["target"], "target")
        self.assertEqual((plan["rollout_extra"], plan["report_extra"]), (6, 3))

    def test_skill_is_visible_but_not_runnable(self):
        rows = adapter.tasks(self.req)["tasks"]
        skill = next(row for row in rows if row["id"] == "skill_l4/target")
        self.assertFalse(skill["supported"])
        self.assertIn("fresh Agent context", skill["reason"])
        self.req["trial"]["task"] = skill["id"]
        with self.assertRaisesRegex(ValueError, "fresh Agent context"):
            adapter.solve(self.req)

    def test_missing_related_task_is_not_silently_dropped(self):
        (self.data / "input/merged/tasks/learn_a/input/learn_a_atomic_expanded_graph.json").unlink()
        rows = adapter.tasks(self.req)["tasks"]
        self.assertFalse(next(row for row in rows if row["id"] == "in_context_l4/target")["supported"])
        self.assertTrue(next(row for row in rows if row["id"] == "zero_shot_l4/target")["supported"])

    def test_memory_taxonomy_only_for_learning_settings(self):
        rows = adapter.tasks(self.req)["tasks"]
        for row in rows:
            self.assertEqual("memory" in row["taxonomy"]["targets"], row["tags"]["suite"] in ("in_context_l4", "skill_l4"))

    def test_agent_cannot_mount_source_plan_or_evidence(self):
        with patch.object(adapter, "native_prompt", return_value="Original task prompt"):
            spec = adapter.solve(self.req)["spec"]
        self.assertNotIn("command", spec)
        self.assertEqual(len(spec["mounts"]), 1)
        self.assertTrue(spec["mounts"][0]["source"].endswith("proxy.py"))
        self.assertNotIn("PYTHONPATH", spec["env"])
        service = spec["services"][0]
        self.assertEqual(service["networks"], ["embodied"])
        self.assertEqual(service["collect"], ["/evidence"])
        self.assertEqual({bind["target"] for bind in service["binds"]}, {"/data", "/upstream", "/adapter"})
        self.assertEqual(spec["agentTask"]["tools"][0]["command"], ["python", "/tools/clbench-mcp.py"])

    def test_dataset_edits_change_frozen_plan(self):
        before = adapter.plan_for(self.req)[2]
        adapter.write(self.data / "input/merged/tasks/target/input/target_atomic_expanded_graph.json", {"changed": True})
        self.assertNotEqual(before["fingerprints"], adapter.plan_for(self.req)[2]["fingerprints"])

    def test_visual_bytes_are_part_of_frozen_plan(self):
        image = self.data / "input/merged/images/observation.png"
        image.parent.mkdir(parents=True)
        image.write_bytes(b"synthetic initial pixels")
        with patch.object(adapter, "image_files", return_value=["images/observation.png"]):
            before = adapter.plan_for(self.req)[2]
            image.write_bytes(b"different synthetic pixels")
            after = adapter.plan_for(self.req)[2]
        self.assertNotEqual(before["fingerprints"], after["fingerprints"])

    def test_valid_target_failure_does_not_become_infra_failure(self):
        self.req["verify"] = {"output": str(self.root / "verify")}
        adapter.write(self.root / "verify/result.json", {
            "task": self.req["trial"]["task"], "source_revision": adapter.REVISION,
            "target": "target", "score": 0, "episodes": [
                {"task_id": "learn_a", "score": {"SR": 1}}, {"task_id": "target", "score": {"SR": 0}}]})
        result = adapter.score(self.req)
        self.assertFalse(result["invalid"])
        self.assertEqual(result["score"], 0)
        self.assertEqual([item["weight"] for item in result["review"]["items"]], [0, 1])

    def test_native_environment_error_is_invalid(self):
        self.req["verify"] = {"output": str(self.root / "verify")}
        adapter.write(self.root / "verify/result.json", {"error": "Missing official observation images"})
        result = adapter.score(self.req)
        self.assertTrue(result["invalid"])
        self.assertIsNone(result["score"])


if __name__ == "__main__":
    unittest.main()
