"""One live BrowserGym episode in an Orbit container. Only the image needs BrowserGym."""

from importlib.metadata import version
import json
from pathlib import Path
import shutil
import time
from datetime import datetime, timezone

from evidence import BROWSERGYM_VERSION, digest, read, trajectory_review, write, sign_result


def observation(obs, action_set):
    visible = {k: obs[k] for k in ("screenshot", "goal", "last_action", "last_action_error")}
    if action_set == "bid":
        from browsergym.utils.obs import flatten_axtree_to_str
        visible["axtree_txt"] = flatten_axtree_to_str(obs["axtree_object"])
    return visible


def capture(output, obs, action_set, step, action, reward, terminated, truncated, info, action_id=None):
    from PIL import Image
    path = f"screenshots/{step:04d}.png"
    Image.fromarray(obs["screenshot"]).save(output / path)
    row = {k: v for k, v in observation(obs, action_set).items() if k != "screenshot"}
    row.update({"step": step, "action": action, "reward": float(reward),
                "terminated": bool(terminated), "truncated": bool(truncated),
                "task_info": info.get("task_info", {}), "screenshot": path})
    if action_id is not None:
        row.update(action_id=action_id, at=datetime.now(timezone.utc).isoformat())
    with (output / "trajectory.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n")
        stream.flush()
    with (output / "trajectory.md").open("a", encoding="utf-8") as stream:
        stream.write(f"\n## Step {step} · reward {reward:g}\n\n")
        if action is not None:
            stream.write("    " + action.replace("\n", "\n    ") + "\n\n")
        stream.write(f"![Observation {step}]({path})\n")
    return row


class Episode:
    """One BrowserGym episode; used by the in-process policy and HTTP bridge."""

    def __init__(self, plan_path, output, signing_key=None):
        self.output = output
        self.signing_key = signing_key
        self.plan = read(plan_path)
        self.result = {"status": "error", "steps": 0}
        self.phase = "environment_setup"
        self.env = None
        self.policy = None
        self.rows = []
        self.started = time.monotonic()
        self.finished = False
        output.mkdir(parents=True, exist_ok=True)
        (output / "screenshots").mkdir(exist_ok=True)
        shutil.copyfile(plan_path, output / "plan.json")

    def start(self):
        if any(version(p) != BROWSERGYM_VERSION for p in ("browsergym-miniwob", "browsergym-core")):
            raise RuntimeError("Image BrowserGym version differs from the recorded version")
        import browsergym.miniwob
        from browsergym.core.action.highlevel import HighLevelActionSet
        import gymnasium as gym

        self.actions = HighLevelActionSet(subsets=[self.plan["action_set"]], multiaction=False, strict=True)
        self.env = gym.make(f"browsergym/{self.plan['task']}", headless=True,
                            action_mapping=self.actions.to_python_code)
        self.obs, info = self.env.reset(seed=self.plan["seed"])
        self.result["versions"] = {name: version(name) for name in
                                  ("browsergym-miniwob", "browsergym-core", "playwright", "gymnasium")}
        self.result["browser_version"] = self.env.unwrapped.page.context.browser.version
        (self.output / "trajectory.md").write_text(
            f"# {self.plan['task']} · seed {self.plan['seed']}\n\n"
            "Reward is computed by the original live BrowserGym environment.\n\n"
            + "    " + self.obs["goal"].replace("\n", "\n    ") + "\n", encoding="utf-8")
        self.rows.append(capture(self.output, self.obs, self.plan["action_set"],
                                 0, None, 0, False, False, info))

    def step(self, action, action_id=None, final_reason=None):
        if self.finished or self.result["steps"] >= self.plan["max_steps"]:
            raise ValueError("Episode is finished")
        if not isinstance(action, str) or not action.strip():
            raise TypeError("Policy must return an action string or None to stop")
        self.phase = "environment_step"
        self.obs, reward, terminated, truncated, info = self.env.step(action)
        self.phase = "capture"
        step = self.result["steps"] + 1
        self.rows.append(capture(self.output, self.obs, self.plan["action_set"], step,
                                 action, reward, terminated, truncated, info, action_id))
        self.result.update(steps=step, reward=float(reward))
        reason = ("terminated" if terminated or truncated else
                  final_reason or ("max_steps" if step == self.plan["max_steps"] else None))
        if reason:
            self.finish(reason, stepped=True)
        return self.rows[-1]

    def fail(self, exc, phase=None):
        self.result.update(status="error", error_type=type(exc).__name__,
                           error_stage=phase or self.phase)
        self.finish(error=True)
        self.persist()

    def finish(self, reason="agent_stop", error=False, stepped=False):
        if self.finished:
            return self.result
        if not error and not stepped and reason in ("empty", "agent_stop"):
            # A stop is the same original no-op used by the external/empty path.
            if not self.rows or self.result["steps"] >= self.plan["max_steps"]:
                raise ValueError("Cannot finish an uninitialized/exhausted episode")
            self.step("noop()", final_reason=reason)
            if self.finished:
                return self.result
        self.finished = True
        if not error:
            self.result.update(status="completed", stop_reason=reason)
        for obj in (self.policy, self.env):
            try:
                if obj is not None and callable(getattr(obj, "close", None)):
                    obj.close()
            except Exception as exc:
                self.result.update(status="error", error_type=type(exc).__name__, error_stage="cleanup")
        self.result["elapsed_sec"] = time.monotonic() - self.started
        self.persist()
        return self.result

    def persist(self):
        if self.rows:
            write(self.output / "trajectory-review.json", trajectory_review(self.rows, self.result, self.plan.get("review_prefix", "")))
        paths = [self.output / "plan.json", self.output / "trajectory.jsonl",
                 *sorted((self.output / "screenshots").glob("*.png"))]
        if (self.output / "trajectory-review.json").is_file():
            paths.append(self.output / "trajectory-review.json")
        self.result["sha256"] = {str(p.relative_to(self.output)): digest(p) for p in paths if p.is_file()}
        write(self.output / "result.json", self.result)
        if self.signing_key is not None:
            sign_result(self.output, self.signing_key)
