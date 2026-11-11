"""Explicit synthetic protocol fixtures; opt-in native checks use the pinned real checkout."""

import copy
from functools import wraps
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("tau2_adapter", Path(__file__).with_name("adapter.py"))
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)

# These are invented protocol fixtures, never used in real calibration or passed off as tau2 data.
TASK_FIXTURE = {"id": "fixture", "user_scenario": {"instructions": "Synthetic fixture"},
                "evaluation_criteria": {"actions": [], "reward_basis": ["DB"]}}
JUDGE_FIXTURE = {**TASK_FIXTURE, "id": "judge", "evaluation_criteria": {
    "actions": [], "reward_basis": ["NL_ASSERTION"], "nl_assertions": ["Synthetic assertion"]}}


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for domain in adapter.DOMAINS:
            p = self.root / f"data/tau2/domains/{domain}/tasks.json"
            p.parent.mkdir(parents=True)
            p.write_text(json.dumps([TASK_FIXTURE, JUDGE_FIXTURE]))
        self.req = {"protocol": 1, "op": "tasks", "benchmark": {"path": str(self.root), "config": {}},
                    "trial": {"id": "fixture-trial", "task": "retail:fixture", "seed": 2,
                              "method": {"agent": "oracle"}, "staging": str(self.root / "stage")},
                    "solve": {"output": str(self.root / "solve")},
                    "verify": {"output": str(self.root / "verify")}}
        for phase in ("solve", "verify"):
            (self.root / phase).mkdir()
        self.pins = patch.object(adapter, "validate_checkout")
        self.pins.start()
        self.addCleanup(self.pins.stop)

    def result_fixture(self, score=0):
        (self.root / "solve/simulation.json").write_text('{"synthetic": true}')
        body = {**adapter.valid(score), "plan": adapter.plan_for(self.req, self.root),
                "episode": {"steps": 0},
                "evidenceSha256": adapter.file_digest(self.root / "solve/simulation.json")}
        adapter.write_json(self.root / "verify/result.json", body)
        return body

    def test_sdk_protocol_and_calibration(self):
        out = io.StringIO()
        code = adapter.main(adapter.tasks, adapter.solve, adapter.verify, adapter.score,
                            argv=["tasks"], stdin=io.StringIO(json.dumps(self.req)), stdout=out)
        self.assertEqual(code, 0)
        body = json.loads(out.getvalue())
        caps = body["capabilities"]
        self.assertNotIn("category", caps)
        self.assertEqual(caps["calibration"], {"oracle": "max", "empty": "any", "repeat": "exact", "seedsVary": False})
        self.assertEqual(len(body["tasks"]), 4)
        for row in body["tasks"]:
            self.assertEqual(row["supported"], not row["id"].endswith(":judge"))
            if not row["supported"]:
                self.assertIn("judge_unavailable", row["reason"])

    def test_nl_diagnostic_does_not_change_reward_basis(self):
        row = copy.deepcopy(TASK_FIXTURE)
        row["evaluation_criteria"]["nl_assertions"] = ["Unscored diagnostic"]
        self.assertIsNone(adapter.unsupported(row))
        row["evaluation_criteria"]["reward_basis"].append("NL_ASSERTION")
        self.assertIn("judge_unavailable", adapter.unsupported(row))

    def test_unknown_basis_and_user_actions_refused(self):
        row = copy.deepcopy(TASK_FIXTURE)
        row["evaluation_criteria"]["reward_basis"] = ["FUTURE"]
        self.assertIsNotNone(adapter.unsupported(row))
        row["evaluation_criteria"]["reward_basis"] = ["DB"]
        row["evaluation_criteria"]["actions"] = [{"requestor": "user"}]
        self.assertIn("dual-control", adapter.unsupported(row))

    def test_isolated_specs_and_rescore_recreates_staging(self):
        for phase, func in (("solve", adapter.solve), ("verify", adapter.verify)):
            spec = func(self.req)["spec"]
            self.assertFalse(spec["network"])
            self.assertEqual(spec["resources"]["gpus"], 0)
            self.assertTrue(all(m["mode"] == "ro" for m in spec["mounts"]))
            self.assertFalse(any(k in spec for k in ("auth", "passEnv", "project")))
            self.assertIn(f"__{phase}", spec["command"])
        plan = self.root / "stage/verify/plan.json"
        before = plan.read_text()
        plan.unlink()
        plan.parent.rmdir()
        adapter.verify(self.req)
        self.assertEqual(plan.read_text(), before)

    def test_external_and_judge_solve_refused(self):
        self.req["trial"]["method"]["agent"] = "external"
        with self.assertRaisesRegex(ValueError, "Only oracle and empty"):
            adapter.solve(self.req)
        self.req["trial"]["method"]["agent"] = "oracle"
        self.req["trial"]["task"] = "retail:judge"
        with self.assertRaisesRegex(ValueError, "judge_unavailable"):
            adapter.solve(self.req)

    def test_forced_judge_verify_is_invalid_not_zero(self):
        self.req["trial"]["task"] = "retail:judge"
        plan = adapter.plan_for(self.req, self.root)
        result = adapter.verify_runtime(self.root, plan, self.root / "solve", self.root / "verify")
        self.assertEqual(result["failure"], "judge_unavailable")
        self.assertIsNone(result["score"])

    def test_solve_scores_are_never_read(self):
        self.result_fixture(0)
        adapter.write_json(self.root / "solve/result.json", {"score": 1, "invalid": False})
        self.assertEqual(adapter.score(self.req)["score"], 0)
        (self.root / "verify/result.json").unlink()
        self.assertTrue(adapter.score(self.req)["invalid"])

    def test_changed_evidence_and_mismatched_identity_invalid(self):
        self.result_fixture()
        (self.root / "solve/simulation.json").write_text("changed")
        self.assertTrue(adapter.score(self.req)["invalid"])
        body = self.result_fixture()
        body["plan"]["seed"] = 99
        adapter.write_json(self.root / "verify/result.json", body)
        self.assertTrue(adapter.score(self.req)["invalid"])

    def test_bad_verifier_score_and_infra_failure(self):
        for score in (None, "1", True, 2):
            body = self.result_fixture()
            body["score"] = score
            adapter.write_json(self.root / "verify/result.json", body)
            self.assertEqual(adapter.score(self.req)["failure"], "scorer_error")
        body = {**adapter.invalid("env_step", "Injected environment failure"),
                "plan": adapter.plan_for(self.req, self.root)}
        adapter.write_json(self.root / "verify/result.json", body)
        result = adapter.score(self.req)
        self.assertEqual(result["failure"], "env_step")
        self.assertIsNone(result["score"])


    def test_state_changes_list_only_differing_paths(self):
        initial = {"orders": {"a": {"status": "pending", "items": [1, 2]}}, "users": {"u": 1}}
        expected = {"orders": {"a": {"status": "cancelled", "items": [1, 2]}}, "users": {"u": 1}}
        actual = {"orders": {"a": {"status": "pending", "items": [1]}}, "users": {"u": 1}}
        rows = adapter.state_changes(initial, expected, actual)
        self.assertEqual(rows, [
            {"path": "orders.a.items[1]", "initial": 2, "expected": 2},
            {"path": "orders.a.status", "initial": "pending", "expected": "cancelled", "actual": "pending"},
        ])
        self.assertEqual(adapter.state_changes(initial, initial, initial), [])


class PinTests(unittest.TestCase):
    def test_source_and_data_corruption(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "src").mkdir()
            (root / "src/fixture.py").write_text("# Explicit source-pin fixture\n")
            (root / "fixture.json").write_text("[]")
            source = adapter.digest({"fixture.py": adapter.file_digest(root / "src/fixture.py")})
            with patch.object(adapter, "SOURCE_SHA256", source), patch.object(adapter, "DATA_SHA256", {
                "fixture.json": adapter.file_digest(root / "fixture.json")
            }):
                adapter.validate_checkout(root)
                (root / "fixture.json").write_text("[1]")
                with self.assertRaisesRegex(ValueError, "data SHA256"):
                    adapter.validate_checkout(root)
                (root / "src/fixture.py").write_text("# Changed fixture\n")
                with self.assertRaisesRegex(ValueError, "source tree"):
                    adapter.validate_checkout(root)


@unittest.skipUnless(os.environ.get("TAU2_TEST_ROOT"), "native checks require the pinned checkout and image dependencies")
class NativeTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(os.environ["TAU2_TEST_ROOT"])
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name)
        from tau2.evaluator.evaluator_nl_assertions import NLAssertionsEvaluator
        from tau2.user.user_simulator import UserSimulator
        # Tripwires, not replacement scorers: these paths must never be invoked.
        for owner, name in ((NLAssertionsEvaluator, "calculate_reward"), (UserSimulator, "generate_next_message")):
            p = patch.object(owner, name, side_effect=AssertionError("No LLM calls permitted"))
            guard = p.start()
            self.addCleanup(p.stop)
            self.addCleanup(guard.assert_not_called)

    def execute(self, task="retail:0", method="oracle"):
        req = {"trial": {"id": "native-test", "task": task, "seed": 2, "method": {"agent": method}}}
        plan = adapter.plan_for(req, self.root)
        source, out = self.out / "solve", self.out / "verify"
        source.mkdir(exist_ok=True)
        out.mkdir(exist_ok=True)
        adapter.solve_runtime(self.root, plan, source)
        result = adapter.verify_runtime(self.root, plan, source, out)
        return plan, source, out, result

    def test_original_evaluator_parity_and_empty_boundary(self):
        from tau2.data_model.simulation import SimulationRun
        from tau2.evaluator.evaluator import EvaluationType, evaluate_simulation
        for task_id, method, expected in (("retail:0", "oracle", 1), ("retail:0", "empty", 0),
                                         ("airline:0", "oracle", 1), ("airline:0", "empty", 1)):
            with self.subTest(task=task_id, method=method):
                plan, source, _, result = self.execute(task_id, method)
                self.assertFalse(result["invalid"], result)
                self.assertEqual(result["score"], expected)
                task, _ = adapter.load_runtime(self.root, plan)
                simulation = SimulationRun.model_validate(json.loads((source / "simulation.json").read_text())["simulation"])
                native = evaluate_simulation(simulation, task, EvaluationType.ALL, False, plan["domain"])
                self.assertEqual(native.reward, result["score"])

    def test_conversation_review_shows_checks_and_final_state(self):
        _, _, out, result = self.execute("retail:0", "oracle")
        conv = json.loads((out / "conversation.json").read_text())
        self.assertEqual((conv["kind"], conv["verdict"]["passed"], result["score"]), ("conversation", True, 1))
        calls = [e for t in conv["turns"] for e in t["events"] if e["type"] == "tool_call"]
        self.assertTrue(calls and all("result" in c for c in calls))
        self.assertTrue(conv["finalState"])
        self.assertTrue(all(r.get("expected") == r.get("actual") for r in conv["finalState"]))
        self.assertEqual(conv["completeness"], "environment-only")
        _, _, out, _ = self.execute("retail:0", "empty")
        conv = json.loads((out / "conversation.json").read_text())
        self.assertFalse(conv["verdict"]["passed"])
        self.assertIn("failed", [c["status"] for c in conv["verdict"]["checks"]])
        self.assertTrue(any(r.get("expected") != r.get("actual") for r in conv["finalState"]))

    def test_forged_score_ignored_and_forged_tool_response_invalid(self):
        plan, source, out, _ = self.execute(method="empty")
        path = source / "simulation.json"
        body = json.loads(path.read_text())
        body["simulation"]["reward_info"] = {"reward": 1}
        adapter.write_json(path, body)
        self.assertEqual(adapter.verify_runtime(self.root, plan, source, out)["score"], 0)
        plan, source, out, _ = self.execute()
        body = json.loads(path.read_text())
        body["simulation"]["messages"][1]["content"] = "FORGED TOOL RESULT"
        adapter.write_json(path, body)
        result = adapter.verify_runtime(self.root, plan, source, out)
        self.assertEqual(result["failure"], "scorer_error")
        self.assertIsNone(result["score"])

    def test_missing_trajectory_and_abnormal_exit_invalid(self):
        plan, source, out, _ = self.execute()
        path = source / "simulation.json"
        body = json.loads(path.read_text())
        body["simulation"]["termination_reason"] = "too_many_errors"
        adapter.write_json(path, body)
        self.assertTrue(adapter.verify_runtime(self.root, plan, source, out)["invalid"])
        path.unlink()
        self.assertTrue(adapter.verify_runtime(self.root, plan, source, out)["invalid"])

    def test_injected_scorer_and_gold_failure_are_not_zero(self):
        from tau2.evaluator import evaluator
        plan, source, out, _ = self.execute()
        with patch.object(evaluator, "evaluate_simulation", side_effect=RuntimeError("Injected scorer crash")):
            result = adapter.verify_runtime(self.root, plan, source, out)
            self.assertEqual(result["failure"], "scorer_error")
            self.assertIsNone(result["score"])
        from tau2.domains.retail.tools import RetailTools
        with patch.object(RetailTools, "exchange_delivered_order_items", side_effect=RuntimeError("Injected DB outage")):
            result = adapter.verify_runtime(self.root, plan, source, out)
            self.assertEqual(result["failure"], "env_step")
            self.assertIsNone(result["score"])

    def test_failed_solve_keeps_partial_trajectory(self):
        from tau2.domains.retail.tools import RetailTools

        @wraps(RetailTools.exchange_delivered_order_items)
        def unavailable(*args, **kwargs):
            raise RuntimeError("Injected DB outage")

        with patch.object(RetailTools, "exchange_delivered_order_items", new=unavailable):
            with self.assertRaises(adapter.InvalidTrial):
                self.execute()
        source = self.out / "solve"
        simulation = json.loads((source / "simulation.json").read_text())["simulation"]
        self.assertEqual(simulation["termination_reason"], "too_many_errors")
        self.assertTrue(simulation["messages"][-1]["error"])
        self.assertIn("too_many_errors", (source / "trajectory.md").read_text())


if __name__ == "__main__":
    unittest.main()
