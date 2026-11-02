"""Scripted click-test calibration, not a general GUI agent or reference oracle."""

import re


class ClickTestPolicy:
    def get_action(self, obs):
        match = re.search(r"\[([^\]]+)\] button.*Click Me!", obs["axtree_txt"])
        if not match:
            raise ValueError("This calibration policy only supports the click-test button")
        return f"click({match.group(1)!r})"


def make_agent(context):
    if context["action_set"] != "bid":
        raise ValueError("click-test calibration requires actionSet=bid")
    return ClickTestPolicy()
