import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from orbit_embodied.binding import file_digest


SERVER = Path(__file__).with_name("serve_chores.py")
spec = importlib.util.spec_from_file_location("chores_policy_server", SERVER)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class ChoresCheckpointTests(unittest.TestCase):
    def test_generated_registrations_declare_released_checkpoint_scope(self):
        with patch.object(sys, "path", [str(SERVER.parent), *sys.path]):
            from configure_chores_policy import definition

        identity = {"checkpointDigest": "fixture", "normalizationDigest": "fixture"}
        for name in json.loads(server.RELEASE.read_text()):
            with self.subTest(name=name):
                scope = definition(name, "fixture", identity, "fixture")["recommendedScope"]
                if name.startswith("spoc-"):
                    self.assertEqual(scope, {"profiles": [name.split("-", 1)[1] + "/1"]})
                else:
                    self.assertEqual(scope["profiles"], ["chores-small/1", "chores-large/1"])
                    self.assertTrue(scope["taskTypes"])
        self.assertEqual(definition("flare-chores-roomvisit", "fixture", identity, "fixture")["recommendedScope"]["taskTypes"],
                         ["SimpleExploreHouse"])

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
