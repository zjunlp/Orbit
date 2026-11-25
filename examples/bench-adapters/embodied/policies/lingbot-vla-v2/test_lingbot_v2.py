"""Check the checkpoint's fixed RoboTwin registration semantics."""

import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from configure_lingbot_v2 import HERE, native_profile


class LingBotV2RegistrationTests(unittest.TestCase):
    def test_registration_requires_the_current_revision_and_preserves_joint_semantics(self):
        source = HERE / "profiles/robotwin-demo-clean.json"
        reference = json.loads(source.read_text())
        self.assertEqual(native_profile(reference)["id"], "lingbot-vla-v2-robotwin-joint-input/1")
        reference["reference"]["evaluation"]["commit"] = "13c3c47ff4312dd62484bcd51be034af55c062d1"
        with self.assertRaisesRegex(ValueError, "expected the current native RoboTwin revision"):
            native_profile(reference)
        reference = json.loads(source.read_text())
        reference["benchmarkProfile"]["observations"]["joint_state"]["order"].reverse()
        with self.assertRaisesRegex(ValueError, "fifty-step joint-control recipe"):
            native_profile(reference)
