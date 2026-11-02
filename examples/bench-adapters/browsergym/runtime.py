"""One live BrowserGym episode in an Orbit container. Only the image needs BrowserGym."""

import importlib
from importlib.metadata import version
import json
import os
from pathlib import Path
import shutil
import sys
import time

from evidence import BROWSERGYM_VERSION, digest, read, trajectory_review, write


def observation(obs, action_set):
    visible = {k: obs[k] for k in ("screenshot", "goal", "last_action", "last_action_error")}
    if action_set == "bid":
        from browsergym.utils.obs import flatten_axtree_to_str
        visible["axtree_txt"] = flatten_axtree_to_str(obs["axtree_object"])
    return visible


def capture(output, obs, action_set, step, action, reward, terminated, truncated, info):
    from PIL import Image
    path = f"screenshots/{step:04d}.png"
    Image.fromarray(obs["screenshot"]).save(output / path)
    row = {k: v for k, v in observation(obs, action_set).items() if k != "screenshot"}
    row.update({"step": step, "action": action, "reward": float(reward),
                "terminated": bool(terminated), "truncated": bool(truncated),
                "task_info": info.get("task_info", {}), "screenshot": path})
    with (output / "trajectory.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n")
        stream.flush()
    with (output / "trajectory.md").open("a", encoding="utf-8") as stream:
        stream.write(f"\n## Step {step} · reward {reward:g}\n\n")
        if action is not None:
            stream.write("    " + action.replace("\n", "\n    ") + "\n\n")
        stream.write(f"![Observation {step}]({path})\n")
    return row


def run(plan_path, output):
    output.mkdir(parents=True, exist_ok=True)
    (output / "screenshots").mkdir(exist_ok=True)
    shutil.copyfile(plan_path, output / "plan.json")
    plan = read(plan_path)
    result = {"status": "error", "steps": 0}
    phase = "environment_setup"
    env = policy = None
    rows = []
    start = time.monotonic()
    try:
        if any(version(p) != BROWSERGYM_VERSION for p in ("browsergym-miniwob", "browsergym-core")):
            raise RuntimeError("Image BrowserGym version differs from the recorded version")
        import browsergym.miniwob  # registers the official tasks
        from browsergym.core.action.highlevel import HighLevelActionSet
        import gymnasium as gym

        action_set = HighLevelActionSet(subsets=[plan["action_set"]], multiaction=False, strict=True)
        env = gym.make(f"browsergym/{plan['task']}", headless=True,
                       action_mapping=action_set.to_python_code)
        obs, info = env.reset(seed=plan["seed"])
        result["versions"] = {name: version(name) for name in
                              ("browsergym-miniwob", "browsergym-core", "playwright", "gymnasium")}
        result["browser_version"] = env.unwrapped.page.context.browser.version
        (output / "trajectory.md").write_text(
            f"# {plan['task']} · seed {plan['seed']}\n\n"
            "Reward is computed by the original live BrowserGym environment.\n\n"
            + "    " + obs["goal"].replace("\n", "\n    ") + "\n", encoding="utf-8")
        rows.append(capture(output, obs, plan["action_set"], 0, None, 0, False, False, info))
        method = plan["method"]
        if method["agent"] == "external":
            phase = "policy_setup"
            for name in method.get("passEnv", []):
                if not os.environ.get(name):
                    raise RuntimeError("A requested model environment variable is missing")
            module, factory = method["entrypoint"].split(":")
            policy = getattr(importlib.import_module(module), factory)(
                {"method": method, "seed": plan["seed"], "action_set": plan["action_set"],
                 "action_description": action_set.describe(with_examples=True)})
            if not callable(getattr(policy, "get_action", None)):
                raise TypeError("Policy factory must return an object with get_action")
        reason = "max_steps"
        for step in range(1, plan["max_steps"] + 1):
            phase = "policy_action"
            action = (policy.get_action(observation(obs, plan["action_set"]))
                      if policy is not None else None)
            stop = action is None
            if stop:
                action = "noop()"
            if not isinstance(action, str) or not action.strip():
                raise TypeError("Policy must return an action string or None to stop")
            phase = "environment_step"
            obs, reward, terminated, truncated, info = env.step(action)
            phase = "capture"
            rows.append(capture(output, obs, plan["action_set"], step, action, reward,
                                terminated, truncated, info))
            result["steps"] = step
            if terminated or truncated:
                reason = "terminated"
                break
            if stop:
                reason = "empty" if policy is None else "agent_stop"
                break
        result.update(status="completed", reward=float(reward), stop_reason=reason)
    except Exception as exc:
        result.update(status="error", error_type=type(exc).__name__, error_stage=phase)
        # Provider exceptions can contain credentials; persist the error type, never its payload.
        print(f"BrowserGym {phase} failed: {type(exc).__name__}", file=sys.stderr)
    finally:
        for obj in (policy, env):
            try:
                if obj is not None and callable(getattr(obj, "close", None)):
                    obj.close()
            except Exception as exc:
                result.update(status="error", error_type=type(exc).__name__, error_stage="cleanup")
        result["elapsed_sec"] = time.monotonic() - start
        if rows:
            write(output / "trajectory-review.json", trajectory_review(rows, result))
        paths = [output / "plan.json", output / "trajectory.jsonl",
                 *sorted((output / "screenshots").glob("*.png"))]
        if (output / "trajectory-review.json").is_file():
            paths.append(output / "trajectory-review.json")
        result["sha256"] = {str(p.relative_to(output)): digest(p) for p in paths if p.is_file()}
        write(output / "result.json", result)
    return 0 if result["status"] == "completed" else 1


if __name__ == "__main__":
    sys.exit(run(Path(sys.argv[1]), Path(os.environ["ORBIT_OUTPUT"])))
