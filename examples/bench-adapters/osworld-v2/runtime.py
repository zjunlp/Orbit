"""One native OSWorld runner, with owned Docker SDK resources and explicit failures."""
import functools
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from types import SimpleNamespace
import zipfile

from evidence import digest, read, redact_text_artifacts, trajectory_review, write


class EvaluatorErrors(logging.Handler):
    """Observe the fixed upstream branches that otherwise convert evaluator exceptions to zero."""
    def __init__(self):
        super().__init__()
        self.failed = False

    def emit(self, record):
        message = record.getMessage()
        if record.name == "desktopenv.env" and (message.startswith("Metric ") and " failed with error:" in message
                                               or message.startswith("No evaluator configured for task ")):
            self.failed = True


class OwnedCreation:
    def __init__(self, run_id, image, vm, resources):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", run_id):
            raise ValueError("Invalid Orbit Run identity")
        self.run_id, self.image, self.vm, self.resources = run_id, image, str(Path(vm).resolve()), resources
        self.created = 0

    def arguments(self, image, command=None, **kwargs):
        if self.created or image != self.image or command is not None:
            raise ValueError("Only one original OSWorld VM can be created per Orbit Run")
        if set(kwargs) - {"devices", "environment", "volumes", "cap_add", "ports", "detach", "labels"}:
            raise ValueError("Unexpected native container creation options")
        if kwargs.get("devices") != ["/dev/kvm"] or kwargs.get("environment", {}).get("KVM") == "N":
            raise ValueError("The original KVM device is required; software emulation is refused")
        expected = {self.vm: {"bind": "/System.qcow2", "mode": "ro"}}
        if kwargs.get("volumes") != expected:
            raise ValueError("Unexpected VM disk mount")
        if kwargs.get("cap_add") != ["NET_ADMIN"] or kwargs.get("privileged") or kwargs.get("labels"):
            raise ValueError("Unexpected native container privileges/labels")
        ports = kwargs.get("ports", {})
        if set(ports) != {8006, 5000, 9222, 8080} or any(type(port) is not int for port in ports.values()):
            raise ValueError("Unexpected native VM ports")
        if kwargs.get("environment", {}).get("CPU_CORES") != "4" or kwargs.get("environment", {}).get("RAM_SIZE") != "4G":
            raise ValueError("Original VM CPU/memory conditions changed")
        self.created += 1
        kwargs.update(labels={"orbit.parent": self.run_id, "orbit.adapter": "osworld-v2"},
                      nano_cpus=4_000_000_000, mem_limit=int((self.resources["memGB"] - 2) * 1024 ** 3),
                      ports={port: ("127.0.0.1", host) for port, host in ports.items()})
        return kwargs

    def install(self, collection):
        original = collection.create
        guard = self

        @functools.wraps(original)
        def create(instance, image, command=None, **kwargs):
            return original(instance, image, command=command, **guard.arguments(image, command, **kwargs))

        collection.create = create


def prepare_vm(plan, staging):
    archive = Path(plan["paths"]["archive"])
    sha = hashlib.sha256()
    with archive.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            sha.update(chunk)
    if "sha256:" + sha.hexdigest() != plan["image"]["artifact_sha256"]:
        raise ValueError("Original VM archive checksum mismatch")
    vm = staging / "vm/System.qcow2"
    vm.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as source:
        disks = [entry for entry in source.infolist() if entry.filename.endswith(".qcow2") and not entry.is_dir()]
        if len(disks) != 1 or not 0 < disks[0].file_size <= 120 * 1024 ** 3:
            raise ValueError("Expected one bounded original qcow2 disk in the release archive")
        if shutil.disk_usage(staging).free < disks[0].file_size + 1024 ** 3:
            raise ValueError("Insufficient trial data disk space for the original VM")
        with source.open(disks[0]) as src, vm.open("xb") as dst:
            shutil.copyfileobj(src, dst, 8 * 1024 * 1024)
    vm.chmod(0o444)
    return vm


def valid_reward(value):
    score = value.get("score") if isinstance(value, dict) else value
    if type(score) not in (int, float) or not math.isfinite(score) or not 0 <= score <= 1:
        raise ValueError("Original evaluator must return a finite score in [0,1]")
    return score


class EmptyAgent:
    def reset(self, *args, **kwargs):
        pass

    def predict(self, instruction, observation):
        return "Empty method: no task action", ["DONE"]


def native_args(plan, native):
    return SimpleNamespace(sleep_after_execution=0.0, checkpoint_eval_mode="off",
                           model=plan["method"].get("model", "empty"), result_dir=str(native))


def run(plan_path):
    plan = read(plan_path)
    output = Path(os.environ["ORBIT_OUTPUT"])
    output.mkdir(parents=True, exist_ok=True)
    native = output / "native"
    native.mkdir(exist_ok=True)
    write(output / "plan.json", plan)
    secrets = [os.environ.get(name, "") for name in plan["method"].get("passEnv", [])]
    result = {"status": "error", "failure": "env_start", "resets": 0, "evaluations": 0}
    env = None
    try:
        run_id = os.environ["ORBIT_RUN_ID"]
        if not os.access("/dev/kvm", os.R_OK | os.W_OK):
            raise RuntimeError("Readable/writable KVM is required")
        task_path = Path(plan["paths"]["tasks"]) / f"{plan['task']}.py"
        if digest(task_path) != plan["task_hash"]["sha256"]:
            raise ValueError("Task file differs from release")
        source_root = plan["root"]
        revision = subprocess.check_output(["git", "-C", source_root, "rev-parse", "HEAD"], text=True).strip()
        dirty = subprocess.check_output(["git", "-C", source_root, "status", "--porcelain", "--", 'desktop_env', 'mm_agents', 'lib_run_single.py', 'lib_results_logger.py', 'task_loader.py', 'benchmark_releases', 'pyproject.toml', 'uv.lock'], text=True)
        if revision != plan["source"] or dirty:
            raise ValueError("Pinned source changed after planning")
        import dotenv
        dotenv.load_dotenv = lambda *args, **kwargs: False
        import docker.models.containers
        if docker.__version__ != "7.1.0":
            raise ValueError("Original Docker SDK 7.1.0 is required")
        from task_loader import load_task_from_file
        from desktop_env import desktop_env
        import lib_run_single

        example = load_task_from_file(str(task_path))
        if example.get("proxy") or example.get("user_simulator") or example.get("image") or example.get("instance_type"):
            raise ValueError("Task-specific services or provider overrides are not supported")
        if example.get("platform", "linux").lower() not in ("linux", "ubuntu") or callable(getattr(example, "get_phases", None)):
            raise ValueError("Only one-phase original Ubuntu tasks are supported")
        # The native setup retry re-creates a VM; use one attempt in one trial.
        desktop_env.MAX_RETRIES = 1
        vm = prepare_vm(plan, Path(plan_path).parent)
        owned = OwnedCreation(run_id, plan["image"]["runtime_image"], vm, plan["resources"])
        owned.install(docker.models.containers.ContainerCollection)
        observed_errors = EvaluatorErrors()
        logging.getLogger("desktopenv.env").addHandler(observed_errors)
        env = desktop_env.DesktopEnv(provider_name="docker", path_to_vm=str(vm), action_space="pyautogui",
                    cache_dir=str(Path(plan_path).parent / "native-cache"), screen_size=(1920, 1080),
                    headless=True, require_a11y_tree=False, require_terminal=False, os_type="Ubuntu", enable_proxy=False)
        native_reset, native_step, native_evaluate = env.reset, env.step, env.evaluate

        def reset(*args, **kwargs):
            result["failure"] = "env_start"
            result["resets"] += 1
            if result["resets"] != 1:
                raise ValueError("A second episode is forbidden")
            observation = native_reset(*args, **kwargs)
            result["failure"] = "policy_act"
            return observation

        def step(*args, **kwargs):
            result["failure"] = "env_step"
            observation = native_step(*args, **kwargs)
            result["failure"] = "policy_act"
            return observation

        def evaluate(*args, **kwargs):
            result["failure"] = "scorer_error"
            result["evaluations"] += 1
            if result["evaluations"] != 1:
                raise ValueError("A second evaluation is forbidden")
            value = native_evaluate(*args, **kwargs)
            valid_reward(value)
            if observed_errors.failed:
                raise ValueError("Upstream evaluator swallowed an exception; result is invalid")
            return value

        env.reset, env.step, env.evaluate = reset, step, evaluate
        result["failure"] = "policy_start"
        if plan["method"]["agent"] == "empty":
            agent = EmptyAgent()
        else:
            from mm_agents.agent import PromptAgent
            config = plan["method"].get("config", {})
            agent = PromptAgent(model=plan["method"].get("model", "gpt-4o"),
                                max_tokens=int(config.get("maxTokens", "1500")), top_p=float(config.get("topP", "0.9")),
                                temperature=float(config.get("temperature", "1.0")), action_space="pyautogui",
                                observation_type="screenshot", max_trajectory_length=3)
        native_predict = agent.predict

        def predict(instruction, observation):
            if not (native / "initial.png").exists():
                (native / "initial.png").write_bytes(observation["screenshot"])
                write(native / "initial-goal.json", instruction)
            return native_predict(instruction, observation)

        agent.predict = predict
        args = native_args(plan, native)
        scores = []
        lib_run_single.run_single_example(agent, env, example, plan["max_steps"], example["instruction"], args, str(native), scores)
        result["failure"] = "scorer_error"
        if owned.created != 1 or result["resets"] != 1 or result["evaluations"] != 1 or len(scores) != 1:
            raise ValueError("Expected one VM, episode and original final score")
        redact_text_artifacts(native, secrets)
        rows = [json.loads(line) for line in (native / "traj.jsonl").read_text().splitlines()]
        write(output / "trajectory-review.json", trajectory_review(read(native / "initial-goal.json"), rows))
        files = ["trajectory-review.json", "plan.json", "native/result.txt", "native/traj.jsonl", "native/initial.png", "native/initial-goal.json"]
        if (native / "result.json").is_file(): files.append("native/result.json")
        files += sorted({"native/" + row["screenshot_file"] for row in rows if row.get("screenshot_file")})
        if any(Path(name).is_absolute() or ".." in Path(name).parts for name in files):
            raise ValueError("Invalid original evidence path")
        result.update(status="completed", score=valid_reward(scores[0]), steps=max(row["step_num"] for row in rows),
                      terminated=bool(rows[-1].get("done")), sha256={name: digest(output / name) for name in files})
        result.pop("failure", None)
    except Exception as error:
        result["error_type"] = type(error).__name__
        print(f"OSWorld failed: {result.get('failure')} ({type(error).__name__})", file=sys.stderr)
    finally:
        # Orbit's existing process cleanup owns the labelled VM even if native close fails or we are cancelled.
        if env is not None:
            try: env.close()
            except Exception: result["native_close_failed"] = True
        redact_text_artifacts(output / "native", secrets)
        if result["status"] == "completed":
            result["sha256"] = {name: digest(output / name) for name in result["sha256"]}
        write(output / "result.json", result)
    return 0 if result["status"] == "completed" else 1


if __name__ == "__main__": sys.exit(run(Path(sys.argv[1])))
