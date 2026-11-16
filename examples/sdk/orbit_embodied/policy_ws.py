"""A policy service that accepts bound observations and emits native action chunks."""

from .openpi import WebSocketPolicy
from .wire import POLICY_FALLBACKS, pack, unpack


class PolicyClient(WebSocketPolicy):
    name = "Orbit policy"

    def __init__(self, url, *, timeout, replan_steps, action_size, conversion=None):
        self.replan_steps = replan_steps
        self.action_size = action_size
        self.conversion = conversion
        self.last_fallback = None
        self.connect(url, timeout, pack, unpack)

    def check_metadata(self, metadata):
        if (not isinstance(metadata, dict) or metadata.get("replanSteps") != self.replan_steps
                or metadata.get("actionSize") != self.action_size):
            raise ValueError("policy service dimensions differ from the frozen profile")
        if metadata.get("actionConversion") != self.conversion:
            raise ValueError("policy service action conversion differs from the frozen policy")

    def reset(self, sample):
        if sample["policySeed"] != 0:
            raise ValueError("the policy service uses a seed-0 stream")

    def act(self, observation):
        reply = self.infer(observation)
        fallback = reply.get("fallback")
        self.last_fallback = fallback if isinstance(fallback, str) and fallback in POLICY_FALLBACKS else None
        return reply["actions"]
