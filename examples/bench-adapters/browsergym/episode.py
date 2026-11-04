"""BrowserGym backend; the shared GUI service owns the episode and evidence lifecycle."""
from importlib import import_module
from importlib.metadata import version
from io import BytesIO
from pathlib import Path
import sys

from evidence import BROWSERGYM_VERSION, read

sys.path.append(str(Path(__file__).resolve().parent.parent.parent / "tools"))
shared = import_module("orbit-gui-service.service")


def observation(obs, action_set):
    visible = {k: obs[k] for k in ("screenshot", "goal", "last_action", "last_action_error")}
    if action_set == "bid":
        from browsergym.utils.obs import flatten_axtree_to_str
        visible["axtree_txt"] = flatten_axtree_to_str(obs["axtree_object"])
    return visible


class BrowserGymBackend:
    def __init__(self, plan):
        self.plan = plan
        self.env = None
        self.raw_obs = None
        self.details = {}

    def reset(self):
        if any(version(p) != BROWSERGYM_VERSION for p in ("browsergym-miniwob", "browsergym-core")):
            raise RuntimeError("Image BrowserGym version differs from the recorded version")
        import browsergym.miniwob
        from browsergym.core.action.highlevel import HighLevelActionSet
        import gymnasium as gym
        self.actions = HighLevelActionSet(subsets=[self.plan["action_set"]], multiaction=False, strict=True)
        self.env = gym.make(f"browsergym/{self.plan['task']}", headless=True,
                            action_mapping=self.actions.to_python_code)
        self.raw_obs, self.reset_info = self.env.reset(seed=self.plan["seed"])
        self.details = {"versions": {name: version(name) for name in
                                   ("browsergym-miniwob", "browsergym-core", "playwright", "gymnasium")},
                        "browser_version": self.env.unwrapped.page.context.browser.version}
        return self.visible()

    def visible(self):
        from PIL import Image
        result = observation(self.raw_obs, self.plan["action_set"])
        data = BytesIO()
        Image.fromarray(result["screenshot"]).save(data, format="PNG")
        result["screenshot"] = data.getvalue()
        return result

    def spec(self):
        height, width = self.raw_obs["screenshot"].shape[:2]
        return {"action_set": self.plan["action_set"],
                "action_description": self.actions.describe(with_examples=True),
                "width": width, "height": height, "stop_action": "noop()",
                "observation": "screenshot + accessibility tree" if self.plan["action_set"] == "bid" else "screenshot"}

    def step(self, action):
        self.raw_obs, reward, terminated, truncated, info = self.env.step(action)
        return self.visible(), float(reward), terminated, truncated, info

    def close(self):
        if self.env is not None:
            self.env.close()


class Episode(shared.Episode):
    def __init__(self, plan_path, output, signing_key=None):
        super().__init__(plan_path, output, BrowserGymBackend(read(plan_path)), signing_key)
