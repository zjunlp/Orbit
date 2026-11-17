from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from .assets import checkpoint_tree_digest, policy_asset_digests, tree_digest


class CheckpointDigestTests(unittest.TestCase):
    def test_checkpoint_identity_excludes_download_bookkeeping_but_keeps_hub_assets(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            checkpoint = root / "checkpoint"
            checkpoint.mkdir()
            weights = checkpoint / "weights.safetensors"
            weights.write_bytes(b"original")
            hub_ref = checkpoint / ".cache/huggingface/hub/models--example/refs/main"
            hub_ref.parent.mkdir(parents=True)
            hub_ref.write_text("revision-1")
            groups = {"checkpointDigest": ["checkpoint"]}
            expected = tree_digest(checkpoint)
            selected = policy_asset_digests(root, groups)
            self.assertEqual(checkpoint_tree_digest(checkpoint), expected)

            download = checkpoint / ".cache/huggingface/download"
            download.mkdir()
            (download.parent / ".gitignore").write_text("*\n")
            for name in ("weights.safetensors.metadata", "weights.safetensors.lock", "shard.incomplete"):
                (download / name).write_text("download bookkeeping")
            self.assertNotEqual(tree_digest(checkpoint), expected)
            self.assertEqual(checkpoint_tree_digest(checkpoint), expected)
            self.assertEqual(policy_asset_digests(root, groups), selected)

            hub_ref.write_text("revision-2")
            self.assertNotEqual(checkpoint_tree_digest(checkpoint), expected)
            hub_ref.write_text("revision-1")
            weights.write_bytes(b"modified")
            self.assertNotEqual(checkpoint_tree_digest(checkpoint), expected)

    def test_bookkeeping_alone_does_not_count_as_a_checkpoint(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            download = root / ".cache/huggingface/download"
            download.mkdir(parents=True)
            (download / "weights.safetensors.metadata").write_text("metadata")
            with self.assertRaisesRegex(ValueError, "asset directory is empty or missing"):
                checkpoint_tree_digest(root)
