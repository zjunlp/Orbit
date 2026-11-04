"""One live BrowserGym episode in an Orbit container."""

import importlib
import os
from pathlib import Path
import sys

from episode import Episode, observation


def run(plan_path, output):
    episode = Episode(plan_path, output)
    policy = None
    try:
        episode.start()
        plan = episode.plan
        method = plan["method"]
        if method["agent"] == "external":
            episode.phase = "policy_setup"
            for name in method.get("passEnv", []):
                if not os.environ.get(name):
                    raise RuntimeError("A requested model environment variable is missing")
            module, factory = method["entrypoint"].split(":")
            policy = getattr(importlib.import_module(module), factory)(
                {"method": method, "seed": plan["seed"], "action_set": plan["action_set"],
                 "action_description": episode.actions.describe(with_examples=True)})
            episode.policy = policy
            if not callable(getattr(policy, "get_action", None)):
                raise TypeError("Policy factory must return an object with get_action")
        while not episode.finished:
            episode.phase = "policy_action"
            action = (policy.get_action(observation(episode.obs, plan["action_set"]))
                      if policy is not None else None)
            if action is None:
                episode.finish("empty" if policy is None else "agent_stop")
            else:
                episode.step(action)
    except Exception as exc:
        episode.fail(exc)
        print(f"BrowserGym {episode.phase} failed: {type(exc).__name__}", file=sys.stderr)
    return 0 if episode.result["status"] == "completed" else 1


if __name__ == "__main__":
    sys.exit(run(Path(sys.argv[1]), Path(os.environ["ORBIT_OUTPUT"])))
