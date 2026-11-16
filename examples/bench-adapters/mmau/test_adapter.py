"""Synthetic protocol fixtures, never presented as real audio/model evaluation."""

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import adapter
import runtime


class AdapterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        row = {"id": "question", "question": "What makes this sound?", "choices": ["bird", "car"],
               "answer": "bird", "audio_id": "test-mini-audios/question.wav", "task": "sound",
               "difficulty": "easy"}
        sources = {"mmau-test-mini.json": json.dumps([row, {**row, "id": "missing",
                   "audio_id": "test-mini-audios/missing.wav"}]),
                   "evaluation.py": 'def string_match(answer, prediction, choices):\n    return answer == prediction\n'}
        hashes = {}
        for name, source in sources.items():
            (self.root / name).write_text(source)
            raw = source.encode()
            hashes[name] = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
        mock = patch.dict(adapter.FILES, hashes)
        mock.start()
        self.addCleanup(mock.stop)
        self.audio = self.root / row["audio_id"]
        self.audio.parent.mkdir()
        self.audio.write_bytes(b"synthetic audio fixture")
        self.req = {"benchmark": {"path": str(self.root)},
                    "trial": {"task": "question", "staging": str(self.root / "stage"),
                              "method": {"agent": "external", "entrypoint": "audio-agent --label 'two words'"}},
                    "solve": {"output": str(self.root / "solve")},
                    "verify": {"output": str(self.root / "verify")}}

    def save_input(self):
        run = adapter.solve(self.req)["spec"]
        output = self.root / "solve/collected"
        (output / "input").mkdir(parents=True)
        (output / "input/task.json").write_bytes((self.root / "stage/solve/task.json").read_bytes())
        (output / "media").mkdir()
        (output / "media/audio.wav").write_bytes(self.audio.read_bytes())
        return run

    def test_source_pin_missing_audio_and_cli_rejection(self):
        rows = adapter.tasks(self.req)["tasks"]
        self.assertEqual([r["supported"] for r in rows], [True, False])
        self.req["trial"]["method"]["agent"] = "codex"
        with self.assertRaisesRegex(ValueError, "audio-capable"):
            adapter.solve(self.req)
        (self.root / "evaluation.py").write_text("changed")
        with self.assertRaisesRegex(ValueError, "differs"):
            adapter.tasks(self.req)

    def test_audio_mount_hidden_labels_and_immutable_rescore(self):
        run = self.save_input()
        visible = json.loads((self.root / "stage/solve/task.json").read_text())
        self.assertNotIn("answers", visible)
        self.assertEqual(run["command"], ["audio-agent", "--label", "two words"])
        self.assertIn({"source": str(self.audio), "target": "/media/audio.wav", "mode": "ro"}, run["mounts"])
        self.assertFalse(adapter.verify(self.req)["spec"]["network"])
        (self.root / "solve/collected/media/audio.wav").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "Collected audio"):
            adapter.verify(self.req)

    def test_missing_answer_zero_and_native_failure_invalid(self):
        self.save_input()
        adapter.verify(self.req)
        output = self.root / "verify"
        output.mkdir()
        runtime.run("verify", self.root / "stage/verify", self.root / "solve", output)
        self.assertEqual(adapter.score(self.req)["score"], 0)
        (self.root / "solve/answers.json").write_text('{"0":"bird"}')
        runtime.run("verify", self.root / "stage/verify", self.root / "solve", output)
        self.assertEqual(adapter.score(self.req)["score"], 1)
        (self.root / "stage/verify/evaluation.py").write_text('raise RuntimeError("fixture failure")')
        runtime.run("verify", self.root / "stage/verify", self.root / "solve", output)
        self.assertTrue(adapter.score(self.req)["invalid"])

    def test_malformed_predictions_and_path_escape(self):
        path = self.root / "answer.json"
        for text in ('[]', '{"0":12}', 'invalid JSON'):
            path.write_text(text)
            self.assertEqual(runtime.prediction(path), "")
        with self.assertRaisesRegex(ValueError, "escapes"):
            adapter.audio_path(self.req, {"audio_id": "../private.wav"})

    def test_empty_external_entrypoint_is_rejected(self):
        for entrypoint in (" ", "''"):
            self.req["trial"]["method"]["entrypoint"] = entrypoint
            with self.assertRaisesRegex(ValueError, "executable"):
                adapter.solve(self.req)


if __name__ == "__main__":
    unittest.main()
