"""Explicit empty method: stop without changing the Android task state."""
from mobile_world.agents.base import BaseAgent
from mobile_world.runtime.utils.models import FINISHED, JSONAction


class EmptyAgent(BaseAgent):
    def predict(self, observation):
        return "Empty method: no task action", JSONAction(action_type=FINISHED)

    def reset(self):
        pass
