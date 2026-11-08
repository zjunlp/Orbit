"""A policy service that accepts bound observations and emits native action chunks."""

from .openpi import WebSocketPolicy
from .wire import pack, unpack


class PolicyClient(WebSocketPolicy):
    name = "Orbit policy"

    def __init__(self, url, *, timeout, replan_steps, action_size):
        self.replan_steps = replan_steps
        self.action_size = action_size
        self.connect(url, timeout, pack, unpack)

    def check_metadata(self, metadata):
        if (not isinstance(metadata, dict) or metadata.get("replanSteps") != self.replan_steps
                or metadata.get("actionSize") != self.action_size):
            raise ValueError("policy service dimensions differ from the frozen profile")

    def reset(self, sample):
        if sample["policySeed"] != 0:
            raise ValueError("the policy service uses a seed-0 stream")

    def act(self, observation):
        return self.infer(observation)["actions"]
