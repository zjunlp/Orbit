"""Explicit transport fixtures; these do not simulate native benchmark execution."""
import importlib.util
from pathlib import Path
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("clbench_runtime", Path(__file__).with_name("runtime.py"))
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


class TransportTests(unittest.TestCase):
    def test_nonterminal_observation_cannot_silently_lose_images(self):
        with self.assertRaisesRegex(RuntimeError, "visual observation is missing"):
            runtime.ensure_images({"next_observation": {"choices": ["A"], "image_paths": [], "done": False}})
        runtime.ensure_images({"choices": [], "image_paths": [], "done": True})

    def test_native_tool_timeout_terminates_process_group(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = Path(directory)
            helper = evidence / "tool_fixture.py"
            helper.write_text(
                "import subprocess, sys\n"
                "if sys.argv[1] == 'child':\n"
                "    from pathlib import Path\n"
                "    import time\n"
                "    time.sleep(1)\n"
                "    Path(__file__).with_suffix('.late').touch()\n"
                "else:\n"
                "    subprocess.run([sys.executable, __file__, 'child'], check=True)\n"
            )
            with patch.object(runtime, "__file__", str(helper)):
                with self.assertRaisesRegex(TimeoutError, "act timed out after 0.2s"):
                    runtime.run_native_call(evidence, "session", "act", {}, 0.2)
            self.assertFalse(helper.with_suffix(".late").exists())

    def test_timeout_cannot_log_success_retry_or_export_partial_state(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = Path(directory)
            events = evidence / "events.jsonl"
            events.touch()
            native = types.SimpleNamespace(runtime_root=evidence / "native")
            dispatch = runtime.dispatcher(native, [{"session_id": "session"}], evidence)
            step = {"index": 0}
            with patch.object(runtime, "run_native_call", return_value={"done": True}) as call:
                self.assertEqual(dispatch(step, "status"), {"done": True})
                call.assert_called_once_with(native.runtime_root, "session", "status", {}, 120)
            with patch.object(runtime, "run_native_call", side_effect=TimeoutError("example")) as call:
                with self.assertRaisesRegex(TimeoutError, "example"):
                    dispatch(step, "act", {"option_id": "A"}, timeout_sec=0.25)
                with self.assertRaisesRegex(RuntimeError, "closed after a native tool timeout"):
                    dispatch(step, "status")
                call.assert_called_once_with(native.runtime_root, "session", "act", {"option_id": "A"}, 0.25)
            self.assertEqual([event["command"] for event in runtime.jsonlines(events)], ["status"])
            with patch.object(runtime, "export") as export:
                with self.assertRaisesRegex(RuntimeError, "example"):
                    runtime.drain_and_export(evidence, threading.Lock(), threading.Event())
                export.assert_not_called()

    def test_whole_tool_serialization_and_finalization_drain(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = Path(directory)
            gate, closing = threading.Lock(), threading.Event()
            entered, release, exported = threading.Event(), threading.Event(), threading.Event()

            def native_tool_fixture():
                entered.set()
                self.assertTrue(release.wait(2))

            def export_fixture(path):
                self.assertTrue(release.is_set())
                runtime.write(path / "finalized.json", {"complete": True})
                exported.set()

            action = runtime.guarded_tool(native_tool_fixture, gate, closing)
            with patch.object(runtime, "export", side_effect=export_fixture) as exporter:
                actor = threading.Thread(target=action)
                actor.start()
                self.assertTrue(entered.wait(2))
                finalizer = threading.Thread(target=runtime.drain_and_export, args=(evidence, gate, closing))
                finalizer.start()
                self.assertTrue(closing.wait(2))
                self.assertFalse(exported.is_set())
                release.set()
                actor.join(2)
                finalizer.join(2)
                self.assertFalse(actor.is_alive())
                self.assertFalse(finalizer.is_alive())
                self.assertTrue(exported.is_set())
                with self.assertRaisesRegex(RuntimeError, "finalizing"):
                    action()
                runtime.drain_and_export(evidence, gate, closing)
                self.assertEqual(exporter.call_count, 1)


if __name__ == "__main__":
    unittest.main()
