"""Explicit in-memory environment and screenshot fixtures; no Chromium or real reward execution."""

import base64
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from episode import Episode
import evidence
from server import Bridge, RequestError


class Screenshot:
    shape = (120, 160, 3)


class FakeEnvironment:
    def __init__(self, events):
        self.events = events
        self.calls = 0
        self.crash = False

    def step(self, action):
        self.calls += 1
        if self.crash:
            raise RuntimeError("injected environment failure")
        return ({"screenshot": Screenshot(), "goal": "fixture goal", "last_action": action,
                 "last_action_error": ""}, 0, False, False, {"task_info": {"RAW_REWARD_GLOBAL": 0}})

    def close(self):
        self.events.append("environment")


def capture_fixture(output, obs, action_set, step, action, reward, terminated, truncated, info, action_id=None):
    path = f"screenshots/{step:04d}.png"
    (output / path).write_bytes(b"explicit PNG fixture")
    row = {"step": step, "goal": obs["goal"], "last_action": action or "",
           "last_action_error": "", "action": action, "reward": reward,
           "terminated": terminated, "truncated": truncated, "task_info": info["task_info"],
           "screenshot": path}
    if action_id:
        row.update(action_id=action_id, at="2026-11-04T00:00:00+00:00")
    with (output / "trajectory.jsonl").open("a") as stream:
        stream.write(json.dumps(row) + "\n")
    return row


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.plan = {"schema": 1, "task": "miniwob.click-test", "seed": 1,
                     "method": {"name": "fixture", "agent": "codex"}, "max_steps": 3,
                     "action_set": "coord", "browsergym_version": evidence.BROWSERGYM_VERSION,
                     "miniwob_commit": evidence.MINIWOB_COMMIT}
        self.patch = patch("episode.capture", side_effect=capture_fixture)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def episode(self, **plan):
        self.plan.update(plan)
        evidence.write(self.root / "plan.json", self.plan)
        e = Episode(self.root / "plan.json", self.root / "out")
        e.obs = {"screenshot": Screenshot(), "goal": "fixture goal"}
        self.events = []
        e.env = FakeEnvironment(self.events)
        e.actions = type("Actions", (), {"describe": lambda *_args, **_kwargs: "original fixture actions"})()
        e.rows.append(capture_fixture(e.output, e.obs, "coord", 0, None, 0, False, False,
                                      {"task_info": {"RAW_REWARD_GLOBAL": 0}}))
        return e

    def test_duplicate_id_returns_original_observation_without_repeating_step(self):
        e = self.episode()
        bridge = Bridge(e)
        first = bridge.dispatch("POST", "/act", {"id": "one", "action": "mouse_click(1, 2)"})
        bridge.dispatch("POST", "/act", {"id": "two", "action": "noop()"})
        duplicate = bridge.dispatch("POST", "/act", {"id": "one", "action": "mouse_click(1, 2)"})
        self.assertEqual(first, duplicate)
        self.assertEqual(e.env.calls, 2)
        with self.assertRaisesRegex(RequestError, "different action"):
            bridge.dispatch("POST", "/act", {"id": "one", "action": "noop()"})

    def test_budget_and_finish_reject_new_actions_but_allow_duplicate(self):
        e = self.episode(max_steps=1)
        bridge = Bridge(e)
        request = {"id": "one", "action": "noop()"}
        first = bridge.dispatch("POST", "/act", request)
        self.assertTrue(first["finished"])
        self.assertEqual(bridge.dispatch("POST", "/act", request), first)
        with self.assertRaisesRegex(RequestError, "finished"):
            bridge.dispatch("POST", "/act", {"id": "two", "action": "noop()"})
        self.assertEqual(evidence.validate(e.output)["steps"], 1)
        self.assertEqual(e.result["stop_reason"], "max_steps")

    def test_finish_without_actions_gets_original_noop_reward_and_is_idempotent(self):
        e = self.episode(max_steps=1)
        bridge = Bridge(e)
        first = bridge.dispatch("POST", "/finish", {})
        self.assertEqual(bridge.dispatch("POST", "/finish", {}), first)
        self.assertEqual(e.env.calls, 1)
        self.assertEqual(e.result["stop_reason"], "agent_stop")
        self.assertEqual(evidence.validate(e.output)["reward"], 0)
        self.assertNotIn("task_info", first)
        self.assertEqual(base64.b64decode(first["screenshot_base64"]), b"explicit PNG fixture")
        with self.assertRaises(RequestError):
            bridge.dispatch("POST", "/act", {"id": "new", "action": "noop()"})

    def test_empty_stop_wins_budget_and_policy_closes_before_environment(self):
        e = self.episode(max_steps=1, method={"name": "empty", "agent": "empty"})
        e.policy = type("Policy", (), {"close": lambda _: self.events.append("policy")})()
        e.finish("empty")
        self.assertEqual(e.result["stop_reason"], "empty")
        self.assertEqual(self.events, ["policy", "environment"])
        self.assertEqual(evidence.validate(e.output)["reward"], 0)

    def test_failed_action_is_not_retried_and_evidence_is_invalid(self):
        e = self.episode()
        e.env.crash = True
        bridge = Bridge(e)
        for _ in range(2):
            with self.assertRaisesRegex(RequestError, "RuntimeError"):
                bridge.dispatch("POST", "/act", {"id": "one", "action": "noop()"})
        self.assertEqual(e.env.calls, 1)
        self.assertEqual(e.result["error_stage"], "environment_step")
        with self.assertRaisesRegex(ValueError, "did not complete"):
            evidence.validate(e.output)

    def test_service_evidence_paths_and_metadata_are_verified(self):
        e = self.episode(review_prefix="services/gui/evidence/")
        bridge = Bridge(e)
        bridge.dispatch("POST", "/act", {"id": "action-1", "action": "noop()"})
        bridge.dispatch("POST", "/finish", {})
        trace = evidence.read(e.output / "trajectory-review.json")
        self.assertEqual(trace["steps"][1]["actionId"], "action-1")
        self.assertEqual(trace["steps"][1]["screenshot"], "services/gui/evidence/screenshots/0001.png")
        self.assertTrue(evidence.validate(e.output)["valid"])


if __name__ == "__main__":
    unittest.main()
