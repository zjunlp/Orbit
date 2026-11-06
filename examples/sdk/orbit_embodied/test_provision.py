"""Pinned asset checksum and resume behavior with synthetic responses."""

import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("fetch_groot", Path(__file__).resolve().parents[2] / "bench-adapters/embodied/fetch_groot.py")
fetcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fetcher)


class Response(io.BytesIO):
    status = 206
    headers = {"Content-Range": "bytes 3-5/6"}


class ProvisionTests(unittest.TestCase):
    def job(self, destination):
        content = b"abcdef"
        sha = hashlib.sha256(content).hexdigest()
        blob = hashlib.sha1(b"blob 6\0" + content).hexdigest()
        return ("synthetic/model", "pinned", {"rfilename": "model.safetensors", "size": 6,
            "lfs": {"sha256": sha}, "blobId": blob}, destination, "https://example.invalid/asset", {"Sha256": sha})

    def test_resumes_partial_and_rejects_corrupted_existing_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "model"
            path.with_name("model.partial").write_bytes(b"abc")
            with patch.object(fetcher.urllib.request.OpenerDirector, "open", return_value=Response(b"def")) as request:
                result = fetcher.fetch(self.job(path))
            self.assertEqual(request.call_args[0][0].get_header("Range"), "bytes=3-")
            self.assertEqual(path.read_bytes(), b"abcdef")
            self.assertEqual(result["bytes"], 6)
            path.write_bytes(b"corrupt")
            with self.assertRaisesRegex(ValueError, "size mismatch"):
                fetcher.fetch(self.job(path))

    def test_complete_partial_is_verified_without_redownloading(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "model"
            path.with_name("model.partial").write_bytes(b"abcdef")
            with patch.object(fetcher.urllib.request.OpenerDirector, "open") as request:
                fetcher.fetch(self.job(path))
            request.assert_not_called()
            self.assertEqual(path.read_bytes(), b"abcdef")

    def test_wrong_same_size_content_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "model"
            path.write_bytes(b"ABCDEF")
            with self.assertRaisesRegex(ValueError, "differs from pinned NVIDIA"):
                fetcher.fetch(self.job(path))

    def test_offline_resolution_only_changes_runtime_metadata_and_keeps_assets_read_only(self):
        spec = importlib.util.spec_from_file_location("serve_groot", Path(SPEC.origin).with_name("serve_groot.py"))
        server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(server)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checkpoint, destination, cache = root / "checkpoint", root / "runtime", root / "hub"
            checkpoint.mkdir()
            destination.mkdir()
            cached = cache / "models--nvidia--Cosmos-Reason2-2B"
            (cached / "refs").mkdir(parents=True)
            (cached / "refs/main").write_text("a" * 40)
            snapshot = cached / "snapshots" / ("a" * 40)
            snapshot.mkdir(parents=True)
            original = {"model_name": "nvidia/Cosmos-Reason2-2B", "other": 123}
            (checkpoint / "config.json").write_text(json.dumps(original))
            (checkpoint / "processor_config.json").write_text(json.dumps({"processor_kwargs": {"other": 456}}))
            (checkpoint / "model.safetensors").write_bytes(b"synthetic weights")
            server.prepare_checkpoint(checkpoint, cache, destination)
            self.assertEqual(json.loads((checkpoint / "config.json").read_text()), original)
            alias = destination / "nvidia/Cosmos-Reason2-2B"
            self.assertEqual(alias.resolve(), snapshot)
            self.assertEqual(json.loads((destination / "config.json").read_text()), {**original, "model_name": str(alias)})
            self.assertEqual((destination / "model.safetensors").resolve(), checkpoint / "model.safetensors")


if __name__ == "__main__":
    unittest.main()
