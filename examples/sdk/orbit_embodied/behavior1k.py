"""BEHAVIOR-1K's original single-environment evaluator and saved-evidence checks."""

import hashlib
import json
import math
import os
import signal
from pathlib import Path
import time

from .binding import check_sample, digest, reference_horizon, validate_observation

SOURCE = {"repository": "https://github.com/StanfordVL/BEHAVIOR-1K",
          "commit": "b544acbbb76b461349bcba21f93b870b11da6608"}
DATA_ROOT = "/behavior-data"
ASSET_DIRS = ("behavior-1k-assets", "omnigibson-robot-assets", "2026-challenge-task-instances")
CAMERAS = {"head": "zed_link", "left_wrist": "left_realsense_link", "right_wrist": "right_realsense_link"}


def asset_digest(root):
    """The licensed encryption key stays outside the fingerprint and all evidence."""
    value = hashlib.sha256()
    root = Path(root)
    for folder in ASSET_DIRS:
        directory = root / folder
        if not directory.is_dir():
            raise ValueError("Missing prepared BEHAVIOR dataset: " + folder)
        for path in sorted(directory.rglob("*")):
            if path.is_symlink():
                raise ValueError("BEHAVIOR assets must not contain symbolic links")
            if path.is_file():
                value.update(path.relative_to(root).as_posix().encode() + b"\0")
                with path.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        value.update(chunk)
                value.update(b"\0")
    return "sha256:" + value.hexdigest()


def profile():
    observations = {
        f"robot_r1::{link}:Camera:0::rgb":
            {"semantic": "rgba", "camera": role, "layout": "HWC",
             "dtype": "uint8", "shape": [224, 224, 4]}
        for role, link in CAMERAS.items()
    }
    proprio = (("base_qvel", 3), ("arm_left_qpos", 7), ("arm_left_qvel", 7),
               ("eef_left_pos", 3), ("eef_left_quat", 4), ("gripper_left_qpos", 2),
               ("gripper_left_qvel", 2), ("arm_right_qpos", 7), ("arm_right_qvel", 7),
               ("eef_right_pos", 3), ("eef_right_quat", 4), ("gripper_right_qpos", 2),
               ("gripper_right_qvel", 2), ("trunk_qpos", 4), ("trunk_qvel", 4))
    observations.update({
        "robot_r1::proprio": {"semantic": "r1pro-native-proprioception", "dtype": "float32", "shape": [61],
            "order": [name + "[" + str(i) + "]" for name, size in proprio for i in range(size)]},
        "robot_r1::cam_rel_poses": {"semantic": "camera-extrinsics", "dtype": "float32", "shape": [21],
                                  "frame": "robot-base", "unit": "metres-and-xyzw",
            "order": [camera + "." + component for camera in ("left_wrist", "right_wrist", "head")
                      for component in ("x", "y", "z", "qx", "qy", "qz", "qw")]},
        "task_id": {"semantic": "behavior-2026-task-index", "dtype": "int64", "shape": [1]},
    })
    order = ["base_x", "base_y", "base_yaw", *["trunk_" + str(i) for i in range(4)],
             *["left_arm_" + str(i) for i in range(7)], "left_gripper",
             *["right_arm_" + str(i) for i in range(7)], "right_gripper"]
    return {"id": "behavior1k-r1pro-native/1", "observations": observations,
            "action": {"semantic": "r1pro-native-joint-targets", "shape": [23], "order": order,
                       "controller": "native-r1pro-joint-position-and-holonomic-base",
                       "frame": "robot-base",
                       "unit": "arms/trunk radians; base native normalized inputs; grippers native normalized inputs",
                       "rotation": "native-joint-angles", "gripper": "native-smooth-controller; no conversion"}}


def native_instance(reference, sample):
    env = reference["environment"]
    index = int(sample["initialStateId"])
    if (sample["environmentSeed"] != 0 or sample["taskId"] not in env["tasks"]
            or sample["taskId"] in env.get("unsupported", {}) or not 0 <= index < 20):
        raise ValueError("BEHAVIOR requires a frozen public-test ordinal 0..19 and native seed 0")
    return 301 + index


def verify_behavior(reference, sample, controls, result, directory):
    import numpy as np
    directory = Path(directory)
    native = result["native"]
    instance = native_instance(reference, sample)
    report = native["report"]
    if json.loads((directory / "behavior-report.json").read_text()) != report:
        raise ValueError("Saved native report differs from the verdict")
    if (report["task"] != sample["taskId"] or report["instance_id"] != instance
            or report["rollout_id"] != 0 or report["steps"] != len(controls)
            or report.get("failure_reason") or type(report["success"]) is not bool
            or report["success"] != result["success"]):
        raise ValueError("BEHAVIOR native result differs from the frozen instance or execution")
    q = report["q_score"]["final"]
    if type(q) not in (int, float) or not math.isfinite(q) or not 0 <= q <= 1:
        raise ValueError("BEHAVIOR Q-score must be a finite fraction")
    if native["score"] != q or native["instanceId"] != instance:
        raise ValueError("BEHAVIOR score or reset identity changed")
    for i, row in enumerate(controls):
        raw = np.load(directory / ("chunks/" + str(row["chunk"]) + ".raw.npy"), allow_pickle=False)
        action = np.load(directory / ("chunks/" + str(row["chunk"]) + ".npy"), allow_pickle=False)
        if raw.shape != (1, 23) or not np.isfinite(raw).all() or not np.array_equal(raw.astype(np.float32), action):
            raise ValueError("BEHAVIOR action differs from the native float32 cast")
        state = row["state"]
        if (state["instanceId"] != instance or state["nativeStep"] != i + 1
                or state["success"] is not row["nativeSuccess"]
                or row["nativeDone"] is not row["terminated"]
                or row["nativeAction"] != row["action"]):
            raise ValueError("BEHAVIOR actions or native stopping evidence changed")
    if not controls or not controls[-1]["terminated"]:
        raise ValueError("BEHAVIOR valid episodes need native termination")


def bounded_query(callback, seconds, timeout_error):
    """Bound the complete synchronous query, including connect, send and metadata."""
    if seconds <= 0:
        raise timeout_error("Native query budget expired")
    previous = signal.getsignal(signal.SIGALRM)
    if signal.getitimer(signal.ITIMER_REAL)[0]:
        raise RuntimeError("An existing process alarm prevents a native query watchdog")
    def expired(*_):
        raise timeout_error("Native query budget expired; request was not retried")
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        return callback()
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def run_native_episode(request, destination, policy, *, prepare=None, cancelled=None):
    """Delegate the entire rollout, first-query allowance and deadlines to upstream."""
    import numpy as np
    from .evidence import seal, write_json

    reference, sample, binding = request["reference"], request["sample"], request["binding"]
    check_sample(sample, sample["sampleId"])
    instance = native_instance(reference, sample)
    directory = Path(destination)
    directory.mkdir(parents=True, exist_ok=False)
    start = time.monotonic()
    identity = {"reference": reference, "policy": request["policy"],
                "execution": {"runId": os.environ["ORBIT_RUN_ID"], "trialId": request["trialId"]},
                "implementationDigest": request["implementationDigest"], "implementationArchive": True}
    horizon = reference_horizon(reference, sample["taskId"], sample=sample)
    contract = {"version": 2, "sampleRef": sample["sampleId"], "episodeId": request["episodeId"],
                "sample": sample, "sampleDigest": digest(sample), "bindingDigest": binding["digest"],
                "horizon": horizon, "replanSteps": 1, "identity": identity}
    write_json(directory / "contract.json", contract)
    write_json(directory / "resolved-binding.json", binding)
    result = {"version": 1, "sampleRef": sample["sampleId"], "episodeId": request["episodeId"],
              "success": False, "valid": False, "steps": 0, "issues": []}
    controls, pending = [], {}
    trace = (directory / "actions.jsonl").open("w")
    try:
        if prepare:
            prepare()
        assets = reference["environment"]["assets"]
        if asset_digest(assets["target"]) != assets["digest"]:
            raise ValueError("BEHAVIOR assets differ from the frozen registration")
        if not (Path(assets["target"]) / "omnigibson.key").is_file():
            raise ValueError("Use the officially installed licensed dataset key")
        from omegaconf import OmegaConf
        import torch as th
        import omnigibson as og
        from omnigibson.macros import gm
        from omnigibson.eval.evaluator import BatchedEvaluator, resolve_instance_ids
        from omnigibson.eval.policies import WebsocketPolicy
        from omnigibson.eval.utils.eval_utils import seed_everything
        from omnigibson.eval.utils.network_utils import PolicyConnectionError, PolicyTimeoutError
        gm.HEADLESS = True
        gm.RENDER_VIEWER_CAMERA = False
        seed_everything(0)
        if resolve_instance_ids(sample["taskId"], [int(sample["initialStateId"])], "public_test") != [instance]:
            raise ValueError("Native BEHAVIOR public split changed")

        class Transport:
            deadline = None

            def set_deadline(self, deadline):
                self.deadline = deadline

            def reset(self):
                policy.definition = {**policy.definition, "callTimeoutSec": min(policy.definition["callTimeoutSec"], 600)}
                remaining = 600 if self.deadline is None else min(600, self.deadline - time.monotonic())
                bounded_query(lambda: policy.reset(sample), remaining, PolicyTimeoutError)

            def act(self, obs):
                if cancelled and cancelled():
                    raise PolicyConnectionError("Orbit cancelled the evaluation")
                policy.client.timeout = min(policy.definition["callTimeoutSec"], 600)
                if self.deadline is not None:
                    remaining = self.deadline - time.monotonic()
                    if remaining <= 0:
                        raise PolicyTimeoutError("Native evaluation deadline expired")
                    policy.client.timeout = min(policy.definition["callTimeoutSec"], remaining, 600)
                inputs = {key: value.detach().cpu().numpy()[0] for key, value in obs.items()
                          if key in reference["benchmarkProfile"]["observations"]}
                validate_observation(inputs, reference["benchmarkProfile"]["observations"])
                mapped = {target: inputs[source] for target, source in binding["observationMap"].items()}
                called = time.monotonic()
                try:
                    raw = np.asarray(bounded_query(lambda: policy.act(mapped), policy.client.timeout, PolicyTimeoutError))
                except Exception as exc:
                    from .driver import EpisodeFailure
                    if isinstance(exc, PolicyTimeoutError):
                        raise
                    if isinstance(exc, EpisodeFailure) and exc.kind == "call_watchdog":
                        raise PolicyTimeoutError(str(exc)) from exc
                    raise PolicyConnectionError(str(exc)) from exc
                if raw.shape != (1, 23) or raw.dtype.kind not in "fiu" or not np.isfinite(raw).all():
                    raise PolicyConnectionError("Policy must return one finite native 23D action")
                action = raw.astype(np.float32)
                chunk = len(controls)
                folder = directory / "chunks"
                folder.mkdir(exist_ok=True)
                np.save(folder / (str(chunk) + ".npy"), action, allow_pickle=False)
                np.save(folder / (str(chunk) + ".raw.npy"), raw, allow_pickle=False)
                write_json(folder / (str(chunk) + ".json"),
                           {"sourceObservation": chunk, "inferSeconds": time.monotonic() - called,
                            "nativeCast": "float32"})
                pending.update(chunk=chunk, action=action[0].tolist())
                return th.from_numpy(action)

            def close(self):
                policy.close()

        class NativePolicy(WebsocketPolicy):
            def __init__(self):
                super().__init__()
                self.policy = Transport()

            def close(self):
                self.policy.close()

        class Evaluator(BatchedEvaluator):
            def load_policy(self):
                return NativePolicy()

            def _apply_actions(self, actions, active_env_indices):
                state = self.instance_eval_states[0]
                if not controls:
                    write_json(directory / "initial-state.json",
                               {"sampleRef": sample["sampleId"], "initialStateId": sample["initialStateId"],
                                "initialStateDigest": sample["initialStateDigest"],
                                "state": {"instanceId": instance, "nativeStep": 0}})
                terminated, truncated, info = super()._apply_actions(actions, active_env_indices)
                stopped = bool(terminated[0] or truncated[0])
                success = bool(state.env_accessor.success)
                native_action = actions[0].detach().cpu().numpy().tolist()
                if native_action != pending["action"]:
                    raise ValueError("Native robot action differs from the recorded policy action")
                row = {"phase": "control", "step": len(controls), "sourceObservation": len(controls),
                       "chunk": pending["chunk"], "chunkIndex": 0, "action": native_action,
                       "nativeAction": native_action, "reward": float(success), "nativeSuccess": success,
                       "terminated": stopped, "nativeDone": stopped, "wallSeconds": time.monotonic() - start,
                       "simulationSeconds": (len(controls) + 1) * float(og.sim.get_rendering_dt()),
                       "state": {"instanceId": instance, "nativeStep": len(controls) + 1, "success": success}}
                trace.write(json.dumps(row, allow_nan=False) + "\n")
                trace.flush()
                controls.append(row)
                result["steps"] = len(controls)
                return terminated, truncated, info

        cfg = OmegaConf.create({"task": {"name": sample["taskId"]}, "headless": True,
            "num_envs": 1, "mode": "public_test", "seed": 0, "partial_scene_load": True,
            "max_steps": None, "write_video": False, "robot": None, "policy_name": "orbit-policy",
            "env_wrapper": {"_target_": "omnigibson.eval.wrappers.DefaultWrapper"}})
        with Evaluator(cfg) as evaluator:
            if evaluator.max_steps != horizon:
                raise ValueError("Native human-demo budget differs from the frozen reference")
            rows = evaluator.run([instance], metrics_dir=str(directory), rollout_id=0)
            report = rows[instance]
            write_json(directory / "behavior-report.json", report)
            result["native"] = {"report": report, "score": report.get("q_score", {}).get("final", 0),
                                "instanceId": instance}
            if report.get("failure_reason"):
                result.update(failure="policy_act", issues=[report["failure_reason"]])
            else:
                result.update(valid=True, success=bool(report["success"]))
    except Exception as exc:
        result.update(valid=False, failure=getattr(exc, "kind", "env_step"), issues=[str(exc)])
    finally:
        trace.close()
        try:
            policy.close()
        except Exception as exc:
            result.update(valid=False, failure="infra")
            result["issues"].append("policy cleanup: " + str(exc))
        result["wallSeconds"] = time.monotonic() - start
        seal(directory, result)
    return result
