"""Explicit transport fixtures; these do not simulate native benchmark execution."""
import importlib.util
from pathlib import Path
import tempfile
import threading
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
