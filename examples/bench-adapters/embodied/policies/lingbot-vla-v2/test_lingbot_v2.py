"""Check the checkpoint's fixed RoboTwin registration semantics."""

import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from configure_lingbot_v2 import HERE, native_profile


class LingBotV2RegistrationTests(unittest.TestCase):
    def test_cross_revision_registration_preserves_joint_semantics(self):
        source = HERE / "profiles/robotwin-demo-clean.json"
        reference = json.loads(source.read_text())
        original = native_profile(reference)
        self.assertEqual(original["id"], "lingbot-vla-v2-robotwin-joint-input/1")
        reference["reference"]["evaluation"]["commit"] = "ea8b21121ebb3cd201ff5b3fe361944ac94eda3f"
        with self.assertRaisesRegex(ValueError, "official reproduction requires RoboTwin"):
            native_profile(reference)
        self.assertEqual(native_profile(reference, allow_other_revision=True), original)
        reference["benchmarkProfile"]["observations"]["joint_state"]["order"].reverse()
        with self.assertRaisesRegex(ValueError, "fifty-step joint-control recipe"):
            native_profile(reference, allow_other_revision=True)
