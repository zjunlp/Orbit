import importlib.util
from pathlib import Path
import tempfile
import unittest

from orbit_embodied.binding import file_digest


SERVER = Path(__file__).with_name("serve_chores.py")
spec = importlib.util.spec_from_file_location("chores_policy_server", SERVER)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class ChoresCheckpointTests(unittest.TestCase):
    def test_rejects_same_length_checkpoint_with_different_content(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkpoint = root / "checkpoint.ckpt"
            checkpoint.write_bytes(b"release")
            release = {"checkpoint": checkpoint.name, "bytes": checkpoint.stat().st_size,
                       "checkpointDigest": file_digest(checkpoint), "files": {}}
            self.assertEqual(server.asset_identity(root, release)["checkpointDigest"], release["checkpointDigest"])
            checkpoint.write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "checkpoint differs from the pinned release"):
                server.asset_identity(root, release)
