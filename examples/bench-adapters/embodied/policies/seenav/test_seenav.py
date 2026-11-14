"""Check pinned assets and SeeNav planner behavior without loading weights."""

import base64
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import numpy as np
from PIL import Image


def load_service():
    spec = importlib.util.spec_from_file_location("serve_seenav", Path(__file__).with_name("serve_seenav.py"))
    service = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(service)
    return service


class SeeNavAssetsTest(unittest.TestCase):
    def test_tokenizer_can_be_lfs_or_a_regular_git_blob(self):
        service = load_service()
        shard = "model-00001-of-00001.safetensors"
        index = "model.safetensors.index.json"
        tokenizer = "tokenizer.json"
        files = {shard: b"synthetic shard", tokenizer: b"{}",
                 index: json.dumps({"weight_map": {"test": shard}}).encode()}

        def blob_id(data):
            return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, data in files.items():
                (root / name).write_bytes(data)
            for checksum in (blob_id, lambda data: hashlib.sha256(data).hexdigest()):
                release = {"files": {shard: hashlib.sha256(files[shard]).hexdigest(),
                                     index: blob_id(files[index]), tokenizer: checksum(files[tokenizer])}}
                with self.subTest(hash_length=len(release["files"][tokenizer])):
                    identity = service.asset_identity(root, release)
                    self.assertIn("normalizationDigest", identity)
                    (root / tokenizer).write_bytes(b"[]")
                    with self.assertRaisesRegex(ValueError, "tokenizer.json"):
                        service.asset_identity(root, release)
                    (root / tokenizer).write_bytes(files[tokenizer])


@unittest.skipUnless(importlib.util.find_spec("planner"), "requires the pinned SeeNav policy image")
class SeeNavPlannerTests(unittest.TestCase):
    def setUp(self):
        service = load_service()
        self.model = Mock()
        self.model.respond.return_value = '{"executable_plan":[{"action_id":2}]}'
        with patch.object(service, "QwenModel", return_value=self.model):
            self.predict, self.reset = service.make_policy(None)
        self.views = np.zeros((500, 1000, 3), dtype=np.uint8)
        self.views[:, :500, 0] = 127
        self.views[:, 500:, 2] = 255
        self.reset()

    def act(self, *, previous=-1, feedback=""):
        with redirect_stdout(io.StringIO()):
            action = self.predict({"navigation_views": self.views, "instruction": "Find the bread.",
                                   "previous_action": np.array([previous], dtype=np.int32),
                                   "previous_feedback": feedback})
        self.assertEqual(action.shape, (1, 1))
        self.assertEqual(action.dtype, np.dtype("int32"))
        return action.item()

    def message(self):
        messages, = self.model.respond.call_args.args
        message, = messages
        return message["content"]

    def test_policy_uses_the_recorded_view_order_and_first_action(self):
        self.model.respond.return_value = '{"executable_plan":[{"action_id":2},{"action_id":6}]}'
        self.assertEqual(self.act(), 2)
        prompt, image = self.message()
        self.assertIn("Find the bread", prompt["text"])
        encoded_image = image["image_url"]["url"].split(",", 1)[1]
        with Image.open(io.BytesIO(base64.b64decode(encoded_image))) as sent:
            np.testing.assert_array_equal(np.asarray(sent), self.views)

    def test_reset_clears_previous_episode_feedback(self):
        self.act()
        feedback = "Last action MoveRight is invalid. Blocked by the chair."
        self.act(previous=2, feedback=feedback)
        self.assertIn(feedback, self.message()[0]["text"])
        self.assertIn("action id 2", self.message()[0]["text"])
        self.reset()
        self.act()
        self.assertNotIn(feedback, self.message()[0]["text"])

    def test_malformed_actions_use_the_episode_seeded_fallback(self):
        malformed = ("garbage", "{}", "null", '{"executable_plan":null}', '{"executable_plan":[0]}',
                     '{"executable_plan":[{"action_id":8}]}', '{"executable_plan":[{"action_id":true}]}',
                     '{"executable_plan":[{"action_id":2.5}]}')
        for _ in range(2):
            self.reset()
            self.model.respond.return_value = '{"executable_plan":[]}'
            self.assertEqual(self.act(), 0)
            expected = np.random.default_rng(0)
            for response in malformed:
                with self.subTest(response=response):
                    self.model.respond.return_value = response
                    self.assertEqual(self.act(), int(expected.integers(8)))
