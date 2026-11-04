"""Validate saved live rewards; this is not a replay or an independent task regrade."""

import base64
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile

BROWSERGYM_VERSION = "0.14.3"
PUBLIC_KEY_ENV = "ORBIT_GUI_EVIDENCE_PUBLIC_KEY"
PRIVATE_KEY_FILE = "evidence-private.pem"

CUA_COMMIT = "2af69268c0573f4c12aac391cc03125e6d5c7974"

MINIWOB_COMMIT = "7fd85d71a4b60325c6585396ec4f48377d049838"


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write(path, value):
    Path(path).write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False),
                          encoding="utf-8")


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def trajectory_review(rows, result, prefix=""):
    if prefix not in ("", "services/gui/evidence/"):
        raise ValueError("Unknown evidence review prefix")
    return {"version": 1, "goal": rows[0].get("goal", ""),
            "steps": [{"step": row["step"], "screenshot": prefix + row["screenshot"],
                       "action": row["action"], "reward": row["reward"],
                       "actionError": row.get("last_action_error") or "",
                       "terminated": row["terminated"], "truncated": row["truncated"],
                       "observation": row.get("axtree_txt", row.get("text", "")),
                       **({"actionId": row["action_id"], "at": row["at"]} if "action_id" in row else {})} for row in rows],
            "stopReason": result.get("stop_reason") or
            f"{result.get('error_stage', 'unknown')}: {result.get('error_type', 'incomplete')}"}



class SignatureError(ValueError):
    pass


def verify_signature(root, public_key):
    try:
        public = base64.b64decode(public_key, validate=True)
        signature = read(root / "evidence-signature.json")
        if not isinstance(signature, dict) or signature.get("algorithm") != "Ed25519":
            raise ValueError("Unsupported evidence signature")
        raw = base64.b64decode(signature["signature"], validate=True)
        if len(public) != 44 or len(raw) != 64:
            raise ValueError("Invalid evidence key or signature size")
        with tempfile.TemporaryDirectory(prefix="orbit-evidence-") as directory:
            directory = Path(directory)
            (directory / "public.der").write_bytes(public)
            (directory / "signature").write_bytes(raw)
            process = subprocess.run(["openssl", "pkeyutl", "-verify", "-pubin", "-keyform", "DER",
                                      "-inkey", str(directory / "public.der"), "-rawin",
                                      "-in", str(root / "result.json"), "-sigfile", str(directory / "signature")],
                                     capture_output=True, timeout=10)
        if process.returncode:
            raise ValueError("Evidence signature does not match the service public key")
    except (OSError, KeyError, TypeError, ValueError, subprocess.SubprocessError) as exc:
        raise SignatureError("Missing or invalid service evidence signature") from exc


def sign_result(root, private_key):
    process = subprocess.run(["openssl", "pkeyutl", "-sign", "-inkey", str(private_key),
                              "-rawin", "-in", str(root / "result.json")], capture_output=True, timeout=10)
    if process.returncode or len(process.stdout) != 64:
        raise ValueError("Service evidence signing failed")
    write(root / "evidence-signature.json", {"algorithm": "Ed25519",
                                            "signature": base64.b64encode(process.stdout).decode()})


def validate(root, public_key=None):
    if public_key is not None:
        verify_signature(root, public_key)
    result = read(root / "result.json")
    if result.get("status") != "completed":
        raise ValueError(f"Episode did not complete: {result.get('error_stage', 'unknown stage')}: "
                         f"{result.get('error_type', 'missing status')}")
    plan = read(root / "plan.json")
    cua = plan.get("backend") == "cua-lite"
    if (plan.get("schema") != 1 or plan.get("browsergym_version") != BROWSERGYM_VERSION
            or plan.get("miniwob_commit") != MINIWOB_COMMIT
            or (cua and plan.get("commit") != CUA_COMMIT)
            or plan.get("backend") not in (None, "browsergym", "cua-lite")):
        raise ValueError("Unknown evidence schema or environment version")
    if (plan.get("action_set") not in (("canonical",) if cua else ("coord", "bid"))
            or not 1 <= plan["max_steps"] <= 1000):
        raise ValueError("Invalid episode budget/action set")
    rows = [json.loads(line) for line in (root / "trajectory.jsonl").read_text().splitlines()]
    steps = result["steps"]
    if type(steps) is not int or not 1 <= steps <= plan["max_steps"] or len(rows) != steps + 1:
        raise ValueError("Trajectory is incomplete or exceeds the step budget")
    required = {"plan.json", "trajectory.jsonl"}
    for i, row in enumerate(rows):
        path = f"screenshots/{i:04d}.png"
        required.add(path)
        if row["step"] != i or row["screenshot"] != path:
            raise ValueError("Trajectory observations are missing or out of order")
        if not (cua and i and row["reward"] is None and not (row["terminated"] or row["truncated"])) and (
                row["reward"] not in (0, 1) or type(row["reward"]) not in (int, float)):
            raise ValueError("Invalid official binary reward")
        if type(row["terminated"]) is not bool or type(row["truncated"]) is not bool:
            raise ValueError("Missing episode termination flags")
        if i < steps and (row["terminated"] or row["truncated"]):
            raise ValueError("Trajectory continued after termination")
        if i and (not isinstance(row["action"], str) or not row["action"]):
            raise ValueError("Missing action")
        if i:
            info = row["task_info"]
            if cua:
                if info.get("pool_unreachable"):
                    raise ValueError("Native CUA-Lite backend is unreachable")
                if ("native_reward" not in info or row["reward"] != info["native_reward"]
                        or row["terminated"] != info.get("native_terminated")
                        or row["truncated"] != info.get("native_truncated")):
                    raise ValueError("Reward/termination disagrees with the native CUA-Lite result")
                call = json.loads(row["action"])
                if (not isinstance(call, dict) or call.get("type") != "function"
                        or not isinstance(call.get("function"), dict)):
                    raise ValueError("Missing native canonical tool call")
            elif info.get("error") in ("invalid page, terminating task", "invalid url, terminating task"):
                if row["reward"] != 0 or not row["terminated"]:
                    raise ValueError("Leaving the task page must terminate with original zero reward")
            else:
                raw = info["RAW_REWARD_GLOBAL"]
                if type(raw) not in (int, float) or not math.isfinite(raw):
                    raise ValueError("Missing original MiniWoB reward")
                if row["reward"] != float(raw > 0):
                    raise ValueError("Reward disagrees with BrowserGym's original MiniWoB rule")
    if type(result["reward"]) not in (int, float) or result["reward"] != rows[-1]["reward"]:
        raise ValueError("Final reward disagrees with the trajectory")
    if cua and not (rows[-1]["terminated"] or rows[-1]["truncated"]):
        raise ValueError("Native CUA-Lite environment has no final verdict")
    reason = result["stop_reason"]
    if reason == "terminated":
        if not (rows[-1]["terminated"] or rows[-1]["truncated"]):
            raise ValueError("Episode claims termination without evidence")
    elif reason == "max_steps":
        if steps != plan["max_steps"]:
            raise ValueError("Episode ended before its step budget")
    elif reason in ("agent_stop", "empty"):
        if not cua and rows[-1]["action"] != "noop()":
            raise ValueError("Stop action is not a noop")
        if reason == "empty" and (plan["method"]["agent"] != "empty" or steps != 1):
            raise ValueError("Empty calibration is not a single noop")
    else:
        raise ValueError("Unknown episode end reason")
    hashes = result["sha256"]
    if (root / "trajectory-review.json").is_file():
        required.add("trajectory-review.json")
        if read(root / "trajectory-review.json") != trajectory_review(rows, result, plan.get("review_prefix", "")):
            raise ValueError("Trajectory review disagrees with the recorded observations")
    if set(hashes) != required or any(digest(root / name) != hashes[name] for name in required):
        raise ValueError("Saved evidence is missing or changed")
    return {"valid": True, "reward": result["reward"], "steps": steps,
            "evidence": "live CUA-Lite reward" if cua else "live BrowserGym reward", "sha256": hashes}


def main():
    try:
        report = validate(Path(sys.argv[1]), os.environ.get(PUBLIC_KEY_ENV))
        write(Path(os.environ["ORBIT_OUTPUT"]) / "validation.json", report)
    except Exception as exc:
        write(Path(os.environ["ORBIT_OUTPUT"]) / "validation.json",
              {"valid": False, "error": f"{type(exc).__name__}: {exc}"})
        sys.exit(1)


if __name__ == "__main__":
    main()
