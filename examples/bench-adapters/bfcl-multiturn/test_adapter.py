"""Explicit synthetic fixtures; real BFCL checks require the pinned package (no model calls)."""

import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "sdk"))
import adapter
import runtime
from orbit_bench import main


def fixture():
    """Invented two-turn filesystem task, not a copied BFCL dataset row."""
    return {
        "entry": {
            "id": "multi_turn_base_0", "question": [
                [{"role": "user", "content": "Create a directory named created."}],
                [{"role": "user", "content": "Enter that directory and list it."}],
            ],
            "initial_config": {"GorillaFileSystem": {
                "root": {"workspace": {"type": "directory", "contents": {}}}}},
            "involved_classes": ["GorillaFileSystem"],
        },
        "ground_truth": [["mkdir(dir_name='created')"], ["cd(folder='created')", "ls()"]],
        "seed": 1, "version": adapter.VERSION, "digests": {"fixture": "synthetic"},
        "tools": {"GorillaFileSystem": [
            {"name": "mkdir", "parameters": {"properties": {"dir_name": {"type": "string"}}}},
            {"name": "cd", "parameters": {"properties": {"folder": {"type": "string"}}}},
            {"name": "ls", "parameters": {"properties": {}}},
        ]},
    }


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        p = fixture()
        files = dict(zip(adapter.data_files("multi_turn_base"),
                         [[p["entry"]], [{"id": p["entry"]["id"], "ground_truth": p["ground_truth"]}]]))
        for cls, name in adapter.DOCS.items():
            files[f"multi_turn_func_doc/{name}.json"] = p["tools"].get(cls, [])
        pins = {}
        for name, rows in files.items():
            path = self.root / name
            path.parent.mkdir(exist_ok=True, parents=True)
            path.write_text("".join(json.dumps(row) + "\n" for row in rows))
            pins[name] = adapter.digest(path)
        self.pins = patch.object(adapter, "PINS", pins)
        self.pins.start()
        self.addCleanup(self.pins.stop)
        self.req = {"benchmark": {"path": str(self.root), "config": {"categories": "multi_turn_base"}},
                    "trial": {"task": "multi_turn_base_0", "seed": 1, "method": {"agent": "oracle"},
                              "staging": str(self.root / "staging")},
                    "solve": {"output": str(self.root / "solve")},
                    "verify": {"output": str(self.root / "verify")}}

    def test_protocol_capabilities_and_calibration(self):
        request = {**self.req, "protocol": 1, "op": "tasks"}
        out = io.StringIO()
        self.assertEqual(main(adapter.tasks, adapter.solve, adapter.verify, adapter.score,
                              ["tasks"], io.StringIO(json.dumps(request)), out), 0)
        result = json.loads(out.getvalue())
        self.assertEqual(len(result["tasks"]), 1)
        self.assertEqual(result["capabilities"]["taxonomy"], {"domains": ["software"]})
        self.assertEqual(result["capabilities"]["methods"], ["oracle", "empty", "cli"])
        self.assertEqual(result["capabilities"]["requires"], ["mcp"])

    def test_data_mutation_fails_closed(self):
        (self.root / adapter.data_files("multi_turn_base")[0]).write_text("{}\n")
        with self.assertRaisesRegex(ValueError, "sha256"):
            adapter.tasks(self.req)

    def test_solve_and_rescore_plans_are_offline(self):
        for method in ("oracle", "empty"):
            self.req["trial"]["method"]["agent"] = method
            spec = adapter.solve(self.req)["spec"]
            self.assertFalse(spec["network"])
            payload = json.loads((self.root / "staging/solve.json").read_text())
            self.assertEqual("ground_truth" in payload, method == "oracle")
        (self.root / "staging/solve.json").unlink()
        spec = adapter.verify(self.req)["spec"]
        self.assertFalse(spec["network"])
        self.assertTrue(all(m["mode"] == "ro" for m in spec["mounts"]))
        self.assertIn("ground_truth", json.loads((self.root / "staging/verify.json").read_text()))

    def test_external_is_explicitly_rejected(self):
        self.req["trial"]["method"]["agent"] = "external"
        with self.assertRaisesRegex(ValueError, "external methods are not supported"):
            adapter.solve(self.req)

    def test_cli_agents_get_the_mcp_server_without_ground_truth(self):
        self.req["trial"]["method"] = {"name": "codex-sol", "agent": "codex", "auth": "p"}
        spec = adapter.solve(self.req)["spec"]
        self.assertNotIn("command", spec)
        tool = spec["agentTask"]["tools"][0]
        self.assertEqual((tool["name"], tool["env"]["BFCL_PAYLOAD"]), ("bfcl", "/bfcl-private/solve.json"))
        self.assertIn("get_user_message", spec["agentTask"]["instruction"])
        self.assertNotIn("ground_truth", json.loads((self.root / "staging/solve.json").read_text()))
        self.assertIn({"source": str(self.root / "staging"), "target": "/bfcl-private", "mode": "rw"},
                      spec["mounts"])
        verify = adapter.verify(self.req)["spec"]
        self.assertEqual(verify["command"][-1], "codex-sol")

    def test_score_ignores_subject_score(self):
        solve = self.root / "solve"
        verify = self.root / "verify"
        solve.mkdir()
        verify.mkdir()
        (solve / "verdict.json").write_text('{"checker": {"valid": true}}')
        self.assertTrue(adapter.score(self.req)["invalid"])
        verdict = {"task": "multi_turn_base_0", "seed": 1, "version": adapter.VERSION,
                   "checker": {"valid": False}, "calls": 0}
        (verify / "verdict.json").write_text(json.dumps(verdict))
        self.assertEqual(adapter.score(self.req)["score"], 0)
        verdict.update(failure="env_step", issue="Explicit injected upstream failure")
        (verify / "verdict.json").write_text(json.dumps(verdict))
        result = adapter.score(self.req)
        self.assertTrue(result["invalid"])
        self.assertEqual(result["failure"], "env_step")
        self.assertIsNone(result["score"])


class ActionTests(unittest.TestCase):
    def test_executable_python_is_not_a_tool_call(self):
        tools = runtime.toolset(fixture(), 0)
        for source in ("__import__('os').system('false')", "ls.__call__()", "ls(*[])" ,
                       "mkdir(dir_name=str(1))", "mkdir(**{})", "ls() or open('/tmp/x','w')",
                       "unknown()", "mkdir(dir_name=(x for x in []))"):
            with self.subTest(source=source), self.assertRaises(runtime.ActionError):
                runtime.parse_call(source, tools)

    def test_missing_tool_is_released_at_its_upstream_turn(self):
        p = fixture()
        p["entry"]["missed_function"] = {"1": ["mkdir"]}
        self.assertNotIn("mkdir", runtime.toolset(p, 0))
        self.assertIn("mkdir", runtime.toolset(p, 1))
        self.assertIn("before release", adapter.support_reason(p["entry"], p["ground_truth"]))

    def test_evidence_identity_and_truncated_turns(self):
        p = fixture()
        saved = {k: p[k] for k in ("seed", "version", "digests")}
        saved.update(task=p["entry"]["id"], turns=[{"turn": i, "calls": []} for i in range(2)])
        self.assertEqual(runtime.evidence_calls(p, saved), [[], []])
        saved["turns"].pop()
        with self.assertRaisesRegex(runtime.RuntimeFailure, "Malformed"):
            runtime.evidence_calls(p, saved)
        saved["seed"] = 2
        with self.assertRaisesRegex(runtime.RuntimeFailure, "identity"):
            runtime.evidence_calls(p, saved)

    def test_reset_fault_is_invalid(self):
        def unavailable(*args, **kwargs):
            raise RuntimeError("Explicit injected reset failure")
        with self.assertRaises(runtime.RuntimeFailure) as cm:
            runtime.replay(fixture(), [[], []], unavailable)
        self.assertEqual(cm.exception.kind, "reset_failed")


class UpstreamTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # The pinned BFCL runs inside the adapter image (the host has no bfcl-eval): skip here, never fake.
        try:
            cls.api = runtime.upstream()
        except runtime.RuntimeFailure as exc:
            raise unittest.SkipTest(str(exc)) from exc

    def test_oracle_empty_and_native_checker_parity(self):
        p = fixture()
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            for turns, expected in ((p["ground_truth"], True), ([[], []], False)):
                evidence, decoded = runtime.replay(p, turns, self.api[0])
                native = runtime.check(p, decoded, self.api[1])
                result = runtime.verify_payload(p, evidence, out, self.api)
                self.assertEqual(result["checker"]["valid"], expected)
                self.assertEqual(result["checker"]["valid"], native["valid"])

    def test_conversation_marks_the_first_failing_turn_and_later_turns_unchecked(self):
        p = fixture()
        evidence, _ = runtime.replay(p, [["mkdir(dir_name='created')"], ["ls()"]], self.api[0])
        with tempfile.TemporaryDirectory() as tmp:
            result = runtime.verify_payload(p, evidence, Path(tmp), self.api, "m")
            conv = json.loads((Path(tmp) / "conversation.json").read_text())
        self.assertEqual(result["failed_turn"], 1)
        self.assertEqual([t["check"]["status"] for t in conv["turns"]], ["passed", "failed"])
        self.assertEqual(conv["verdict"]["failedTurn"], 1)
        self.assertFalse(conv["verdict"]["passed"])
        self.assertNotIn("execution_result", conv["verdict"]["details"])
        first = conv["turns"][0]
        self.assertEqual([e["type"] for e in first["events"]], ["message", "tool_call"])
        self.assertEqual(first["events"][1]["arguments"], {"dir_name": "created"})
        self.assertEqual(first["reference"], ["mkdir(dir_name='created')"])
        self.assertEqual(first["state"]["after"], first["state"]["expected"])
        # A wrong first turn leaves the second unchecked.
        evidence, _ = runtime.replay(p, [["ls()"], ["ls()"]], self.api[0])
        with tempfile.TemporaryDirectory() as tmp:
            runtime.verify_payload(p, evidence, Path(tmp), self.api, "m")
            conv = json.loads((Path(tmp) / "conversation.json").read_text())
        self.assertEqual([t["check"]["status"] for t in conv["turns"]], ["failed", "unchecked"])
        evidence, _ = runtime.replay(p, [["mkdir(unknown='x')"], []], self.api[0])
        self.assertEqual(runtime.call_event(evidence["turns"][0]["calls"][0])["status"], "rejected")

    def test_mcp_conversation_records_evidence_that_verify_replays(self):
        import bfcl_mcp
        p = fixture()
        del p["ground_truth"]
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            conv = bfcl_mcp.Conversation(p, out, self.api)
            msgs = [
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "call_function", "arguments": {"name": "mkdir"}}},
                {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "get_user_message"}},
                {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "list_functions"}},
                {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "call_function", "arguments": {"name": "mkdir", "arguments": {"dir_name": "created"}}}},
                {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "get_user_message", "arguments": {"response": "Done."}}},
                {"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": "call_function", "arguments": {"name": "rm", "arguments": {}}}},
            ]
            stdout = io.StringIO()
            bfcl_mcp.serve(conv, io.StringIO("".join(json.dumps(m) + "\n" for m in msgs)), stdout)
            replies = {r["id"]: r for r in map(json.loads, stdout.getvalue().splitlines())}
            self.assertEqual(sorted(replies), [1, 2, 3, 4, 5, 6, 7, 8])
            self.assertEqual([t["name"] for t in replies[2]["result"]["tools"]],
                             ["get_user_message", "list_functions", "call_function"])
            self.assertTrue(replies[3]["result"]["isError"])  # before the first turn
            first = json.loads(replies[4]["result"]["content"][0]["text"])
            self.assertEqual((first["turn"], first["of"]), (1, 2))
            self.assertIn("mkdir", [f["name"] for f in json.loads(replies[5]["result"]["content"][0]["text"])])
            self.assertIn("Tool is unavailable: rm", replies[8]["result"]["content"][0]["text"])
            evidence = json.loads((out / "evidence.json").read_text())
            # The second turn was reached; the agent stopped before finishing it.
            self.assertEqual([len(t["calls"]) for t in evidence["turns"]], [1, 1])
            self.assertEqual(evidence["turns"][0]["final_response"], "Done.")
            full = fixture()
            result = runtime.verify_payload(full, evidence, out, self.api, "codex")
            self.assertFalse(result["checker"]["valid"])
            self.assertEqual(result["failed_turn"], 1)
            conv = json.loads((out / "conversation.json").read_text())
            self.assertEqual(conv["turns"][0]["events"][-1], {"type": "message", "actor": "agent", "text": "Done."})
            self.assertEqual(conv["turns"][1]["events"][-1]["status"], "rejected")

    def test_tampered_results_states_and_score_do_not_change_score(self):
        p = fixture()
        evidence, _ = runtime.replay(p, [[], []], self.api[0])
        evidence["score"] = 1
        for row in evidence["turns"]:
            row["state_after"] = {"forged": True}
            row["results"] = ["success"]
        with tempfile.TemporaryDirectory() as tmp:
            self.assertFalse(runtime.verify_payload(p, evidence, Path(tmp), self.api)["checker"]["valid"])

    def test_schema_error_is_valid_failure_and_cannot_execute_code(self):
        p = fixture()
        for source in ("mkdir(unknown='created')",
                       "__import__('os').system('false')"):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as tmp:
                evidence, _ = runtime.replay(p, [[source], []], self.api[0])
                self.assertIn("action_error", evidence["turns"][0]["calls"][0])
                result = runtime.verify_payload(p, evidence, Path(tmp), self.api)
                self.assertFalse(result["checker"]["valid"])

    def test_upstream_acceptance_overrides_schema_type_hints(self):
        class TicketFixture:
            def close_ticket(self, ticket_id):
                pass
        # The real pinned corpus includes string ticket IDs despite integer schema hints.
        self.assertTrue(runtime.check_arguments(TicketFixture().close_ticket, [], {"ticket_id": "ticket_001"},
                                                {"parameters": {"properties": {"ticket_id": {"type": "integer"}}}}))
        p = fixture()
        evidence, decoded = runtime.replay(p, [["mkdir(dir_name=42)"], []], self.api[0])
        self.assertNotIn("action_error", evidence["turns"][0]["calls"][0])
        self.assertFalse(runtime.check(p, decoded, self.api[1])["valid"])

    def test_missing_submission_uses_upstream_empty_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = runtime.verify_payload(fixture(), None, Path(tmp), self.api)
            self.assertFalse(result["checker"]["valid"])

    def test_failed_solve_is_not_a_missing_submission_zero(self):
        p = fixture()
        p["solve_failed"] = True
        with tempfile.TemporaryDirectory() as tmp, self.assertRaises(runtime.RuntimeFailure) as cm:
            runtime.verify_payload(p, None, Path(tmp), self.api)
        self.assertEqual(cm.exception.kind, "env_step")

    def test_upstream_execution_fault_cannot_hide_behind_schema_mismatch(self):
        from bfcl_eval.eval_checker.multi_turn_eval.func_source_code.gorilla_file_system import GorillaFileSystem

        def broken(self, dir_name):
            raise RuntimeError("Explicit injected infrastructure fault")
        with patch.object(GorillaFileSystem, "mkdir", broken):
            for value in ("'created'", "42"):
                with self.assertRaises(runtime.RuntimeFailure) as cm:
                    runtime.replay(fixture(), [[f"mkdir(dir_name={value})"], []], self.api[0])
                self.assertEqual(cm.exception.kind, "env_step")

    def test_bad_value_type_is_behavior_not_infrastructure(self):
        def needs_number(value):
            return value + 1
        self.assertTrue(runtime.call_tool(needs_number, ["bad"], {}, True).startswith("Error during execution:"))

    def test_checker_exception_and_reference_failure_are_invalid(self):
        def crash(*args):
            raise RuntimeError("Explicit injected checker failure")
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(runtime.RuntimeFailure) as cm:
                runtime.verify_payload(fixture(), None, Path(tmp), (self.api[0], crash, self.api[2]))
            self.assertEqual(cm.exception.kind, "scorer_error")
            with self.assertRaisesRegex(runtime.RuntimeFailure, "self-check"):
                runtime.verify_payload(fixture(), None, Path(tmp),
                                       (self.api[0], lambda *a: {"valid": False}, self.api[2]))

    def test_replay_resets_state(self):
        p = fixture()
        first, _ = runtime.replay(p, p["ground_truth"], self.api[0])
        second, _ = runtime.replay(p, p["ground_truth"], self.api[0])
        self.assertEqual(first, second)

    def test_state_success_alone_does_not_replace_response_check(self):
        p = fixture()
        turns = [["mkdir(dir_name='created')"], ["cd(folder='created')"]]
        evidence, decoded = runtime.replay(p, turns, self.api[0])
        truth, _ = runtime.replay(p, p["ground_truth"], self.api[0])
        self.assertEqual(evidence["turns"][-1]["state_after"], truth["turns"][-1]["state_after"])
        verdict = runtime.check(p, decoded, self.api[1])
        self.assertFalse(verdict["valid"])
        self.assertEqual(verdict["error_type"], "multi_turn:execution_response_mismatch")


if __name__ == "__main__":
    unittest.main()
