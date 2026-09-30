"""Task-owned supervisor child: run a command through the existing Docker backend."""

import json
import os
import shutil
import signal
import sys
import threading
import time
from pathlib import Path

from agent_infra.contracts.files import content_digest
from agent_infra.environments.api import InputMount, LogCursor, ProcessCommand, SandboxSpec
from agent_infra.environments.command_api import CommandExecutionSpec
from agent_infra.environments.docker import DockerEnvironment
from agent_infra.environments.recovery import docker_environment, write_ownership


def run(root: Path, gpu_mode: str) -> int:
    spec = CommandExecutionSpec.model_validate_json((root / "command.json").read_bytes())
    transport = json.loads((root / "transport.json").read_text())
    docker_environment(transport["docker_host"])  # Validate before using persisted transport.
    os.environ.pop("DOCKER_CONTEXT", None)
    os.environ["DOCKER_HOST"] = transport["docker_host"]
    cancelled = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: cancelled.set())
    signal.signal(signal.SIGINT, lambda *_: cancelled.set())
    workspace = Path(spec.workspace)
    snapshot = Path(spec.snapshot)
    if content_digest(snapshot) != spec.snapshot_digest:
        raise ValueError("frozen code snapshot changed before execution")
    shutil.copytree(snapshot, workspace, dirs_exist_ok=True)
    evidence = workspace / ".infra-evidence"
    evidence.mkdir(mode=0o700)
    shutil.copytree(snapshot.parent / "evidence", evidence, dirs_exist_ok=True)
    (workspace / "outputs").mkdir(exist_ok=True)
    docker = DockerEnvironment(
        root / "docker", log_limit_bytes=spec.max_log_bytes, gpu_mode=gpu_mode
    )
    handle = None
    result: dict[str, object] = {"status": "failed", "logs_truncated": False, "allocation": None}
    try:
        handle = docker.prepare(
            SandboxSpec(
                spec.attempt_id,
                "solver",
                spec.image,
                workspace,
                spec.cpu_cores,
                spec.memory_bytes,
                spec.gpu_device_ids,
                tuple(InputMount(Path(m.source), m.target) for m in spec.mounts)
                + (InputMount(evidence, "/workspace/.infra-evidence"),),
                network=spec.network,
            )
        )
        docker.start(
            handle,
            ProcessCommand(
                spec.command.argv,
                cwd="/workspace" if spec.command.cwd == "." else "/workspace/" + spec.command.cwd,
                environment=(
                    ("INFRA_RUN_ID", spec.run_id),
                    ("INFRA_OUTPUT", "/workspace/outputs"),
                    ("INFRA_METRICS", "/workspace/outputs/metrics.jsonl"),
                ),
                timeout_seconds=spec.command.timeout_seconds,
            ),
        )
        result["allocation"] = {
            "cpu_cores": spec.cpu_cores,
            "memory_bytes": spec.memory_bytes,
            "gpu_count": len(spec.gpu_device_ids),
            "source": "docker-inspect-verified",
        }
        ownership = json.loads((root / "docker" / handle.id / "ownership.json").read_text())
        result["docker"] = {key: ownership[key] for key in ("name", "image_id", "owner")}
        cursor = LogCursor()
        while True:
            if cancelled.is_set():
                docker.cancel(handle)
            observation = docker.observe(handle, cursor)
            cursor = observation.cursor
            sys.stdout.write(observation.stdout)
            sys.stderr.write(observation.stderr)
            sys.stdout.flush()
            sys.stderr.flush()
            if observation.status != "running":
                status = observation.status
                if status == "exited":
                    status = "completed" if observation.exit_code == 0 else "failed"
                result.update(
                    status=status,
                    exit_code=observation.exit_code,
                    logs_truncated=observation.logs_truncated,
                )
                # observe drains bounded chunks; do not lose a terminal tail.
                if not observation.stdout and not observation.stderr:
                    break
            else:
                time.sleep(0.1)
    except Exception as error:
        print(
            f"Docker experiment failed: {type(error).__name__}: {error}",
            file=sys.stderr,
            flush=True,
        )
    finally:
        cleanup = docker.cleanup(handle) if handle else None
        result["cleanup_complete"] = cleanup.complete if cleanup else True
        write_ownership(root / "result.json", result)
        write_ownership(evidence / "execution.json", result)
    return 0 if result["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(run(Path(sys.argv[1]), sys.argv[2]))
