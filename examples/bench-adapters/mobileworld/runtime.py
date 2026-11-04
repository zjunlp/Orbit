"""Run one original mw eval task; Orbit owns the emulator container lifecycle."""
import asyncio
import functools
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

from evidence import digest, original_score, read, redact_text_artifacts, trajectory_review, write


# Exception class names of model SDKs whose failure means the model, not the policy, was unusable.
MODEL_ERRORS = re.compile(r"(APIError|APIConnectionError|APITimeoutError|RateLimitError|AuthenticationError|PermissionDeniedError|InternalServerError|ServiceUnavailable|Overloaded)")


def docker(command):
    return subprocess.check_output(["docker", *command], text=True, timeout=60).strip()


def native_arguments(plan, url, output, agent):
    args = ["eval", "--task", plan["task"], "--agent-type", agent, "--aw-host", url,
            "--log-file-root", str(output / "native"), "--max-round", str(plan["max_steps"]),
            "--max-concurrency", "1", "--pass-k", "1", "--auto-retry", "0"]
    method = plan["method"]
    if method.get("model"):
        args.extend(["--model-name", method["model"]])
    if method.get("config", {}).get("baseUrl"):
        args.extend(["--llm-base-url", method["config"]["baseUrl"]])
    return args


def install_episode_guards(runner, client_class, requests, result):
    original_process = runner._process_task_on_env

    @functools.wraps(original_process)
    def single_attempt(*args, **kwargs):
        kwargs["retry_on_device_unhealthy"] = 0
        return original_process(*args, **kwargs)

    runner._process_task_on_env = single_attempt
    for name, stage in (("initialize_task", "env_start"), ("execute_action", "env_step"), ("get_task_score", "scorer_error")):
        original = getattr(client_class, name)

        def guarded(self, *args, _original=original, _name=name, _stage=stage, **kwargs):
            result["failure"] = _stage
            if _name == "initialize_task":
                result["initializations"] += 1
                if result["initializations"] != 1:
                    raise RuntimeError("A second episode is forbidden")
            if _name == "get_task_score":
                result["evaluations"] += 1
                if result["evaluations"] != 1:
                    raise RuntimeError("A second evaluation is forbidden")
            value = _original(self, *args, **kwargs)
            result["failure"] = "policy_act"
            return value

        setattr(client_class, name, guarded)
    original_get = requests.get

    def checked_get(url, *args, **kwargs):
        response = original_get(url, *args, **kwargs)
        if str(url).endswith("/task/eval"):
            response.raise_for_status()
            value = response.json()
            score = value.get("score") if isinstance(value, dict) else None
            if type(score) not in (int, float) or not math.isfinite(score) or not 0 <= score <= 1:
                raise ValueError("Original evaluator did not return a finite score in [0,1]")
        return response

    requests.get = checked_get


def run(plan_path):
    plan = read(plan_path)
    output = Path(os.environ["ORBIT_OUTPUT"])
    output.mkdir(parents=True, exist_ok=True)
    write(output / "plan.json", plan)
    secrets = [os.environ.get(name, "") for name in plan["method"].get("passEnv", [])]
    result = {"status": "error", "failure": "env_start", "initializations": 0, "evaluations": 0}
    name = None
    try:
        run_id = os.environ["ORBIT_RUN_ID"]
        if not re.fullmatch(r"[A-Za-z0-9_-]+", run_id) or not os.access("/dev/kvm", os.R_OK | os.W_OK):
            raise RuntimeError("An Orbit process Run with working KVM is required")
        shim = Path(shutil.which("docker") or "")
        if not shim.is_file() or "__docker-shim" not in shim.read_text():
            raise RuntimeError("Orbit's labelled Docker shim is required")
        source_root = plan["root"]
        revision = subprocess.check_output(["git", "-C", source_root, "rev-parse", "HEAD"], text=True).strip()
        dirty = subprocess.check_output(["git", "-C", source_root, "status", "--porcelain", "--", 'src', 'pyproject.toml', 'uv.lock', 'docker'], text=True)
        if revision != plan["source"] or dirty:
            raise ValueError("Pinned source changed after planning")
        import dotenv
        dotenv.load_dotenv = lambda *args, **kwargs: False
        import requests
        from mobile_world.core import runner
        from mobile_world.core.api.env import wait_for_container_ready
        from mobile_world.core.cli import create_parser
        from mobile_world.core.subcommands.eval import execute
        from mobile_world.runtime.client import AndroidEnvClient
        from mobile_world.runtime.utils.docker import build_run_command

        root = Path(plan["root"])
        name = f"orbit-mobileworld-{run_id}"
        command = build_run_command(name=name, image=plan["image"],
            volumes=[(str(root / "src"), "/app/service/src:ro"),
                     (str(root / "pyproject.toml"), "/app/service/pyproject.toml:ro"),
                     (str(root / "uv.lock"), "/app/service/uv.lock:ro")],
            env_vars={"PYTHONDONTWRITEBYTECODE": "1", "UV_FROZEN": "1"},
            privileged=True, detach=True, remove=False)
        command[-1:-1] = ["--cpus", str(plan["resources"]["cpus"] - 1),
                           "--memory", f"{int((plan['resources']['memGB'] - 2) * 1024)}m",
                           "-p", "127.0.0.1::6800"]
        subprocess.run(command, check=True, capture_output=True, text=True, timeout=60)
        info = json.loads(docker(["inspect", name]))[0]
        if info["Config"]["Labels"].get("orbit.parent") != run_id:
            raise RuntimeError("Emulator was not labelled by Orbit")
        bindings = info["NetworkSettings"]["Ports"]["6800/tcp"]
        if len(bindings) != 1 or bindings[0]["HostIp"] != "127.0.0.1":
            raise RuntimeError("Unexpected emulator port binding")
        port = int(bindings[0]["HostPort"])
        if not wait_for_container_ready(port, timeout=plan["ready_timeout"]):
            raise RuntimeError("Original emulator did not become ready")
        install_episode_guards(runner, AndroidEnvClient, requests, result)
        agent = str(Path(plan_path).parent / "empty_agent.py") if plan["method"]["agent"] == "empty" else plan["method"]["entrypoint"]
        result["failure"] = "policy_start"
        args = create_parser().parse_args(native_arguments(plan, f"http://127.0.0.1:{port}", output, agent))
        asyncio.run(execute(args))
        redact_text_artifacts(output / "native", secrets)
        native = output / "native" / plan["task"]
        rows = read(native / "traj.json")["0"]["traj"]
        if not rows:
            result["failure"] = "policy_act"
            raise RuntimeError("Original trajectory is missing")
        result["failure"] = "scorer_error"
        score = original_score((native / "result.txt").read_text())
        if result["initializations"] != 1 or result["evaluations"] != 1:
            raise RuntimeError("Expected one initialized episode and final evaluation")
        write(output / "trajectory-review.json", trajectory_review(plan["task"], rows))
        files = ["trajectory-review.json", "plan.json", f"native/{plan['task']}/traj.json", f"native/{plan['task']}/result.txt"]
        files += [f"native/{plan['task']}/screenshots/{plan['task']}-0-{i}.png" for i in range(1, len(rows) + 1)]
        result.update(status="completed", score=score, steps=len(rows), sha256={file: digest(output / file) for file in files})
        result.pop("failure", None)
    except (Exception, SystemExit) as error:
        result["error_type"] = type(error).__name__
        if result.get("failure") == "policy_act" and MODEL_ERRORS.search(type(error).__name__):
            result["failure"] = "model_unavailable"
        print(f"MobileWorld failed: {result['failure']} ({type(error).__name__})", file=sys.stderr)
    finally:
        # The process backend collects and removes every orbit.parent container, even after cancellation.
        redact_text_artifacts(output / "native", secrets)
        if result["status"] == "completed":
            result["sha256"] = {name: digest(output / name) for name in result["sha256"]}
        write(output / "result.json", result)
    return 0 if result["status"] == "completed" else 1


if __name__ == "__main__":
    sys.exit(run(Path(sys.argv[1])))
