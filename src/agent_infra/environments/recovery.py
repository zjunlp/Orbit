"""Local Docker inspection and conservative recovery from durable ownership journals."""

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any


def write_ownership(path: Path, entry: dict[str, Any]) -> None:
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as file:
        json.dump(entry, file)
        file.flush()
        os.fsync(file.fileno())
    temporary.replace(path)
    for directory in (path.parent, path.parent.parent):
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def docker_json(*args: str, docker_host: str | None = None) -> Any:
    result = subprocess.run(
        ["docker", *args],
        capture_output=True,
        text=True,
        timeout=30,
        env=docker_environment(docker_host) if docker_host else None,
    )
    if result.returncode:
        raise RuntimeError(f"Docker {args[0]} unavailable; check local daemon and image")
    return json.loads(result.stdout) if result.stdout.strip() else None


def docker_environment(endpoint: str) -> dict[str, str]:
    if not endpoint.startswith("unix:///"):
        raise ValueError("local execution requires an absolute Unix Docker socket")
    return {key: value for key, value in os.environ.items() if key != "DOCKER_CONTEXT"} | {
        "DOCKER_HOST": endpoint
    }


def local_docker_endpoint() -> str:
    context = docker_json("context", "inspect")[0]
    endpoint = context["Endpoints"]["docker"]["Host"]
    if not os.environ.get("DOCKER_CONTEXT"):
        endpoint = os.environ.get("DOCKER_HOST") or endpoint
    if not endpoint.startswith("unix:///"):
        raise ValueError("controller requires a local Unix Docker endpoint")
    return str(endpoint)


def inspect_local_image(image: str, *, provider: str | None = None) -> str:
    local_docker_endpoint()
    info = docker_json("image", "inspect", image)[0]
    if info["Config"].get("Volumes"):
        raise ValueError("image declares implicit volumes; use a volume-free image")
    if provider is not None:
        labels = info["Config"].get("Labels") or {}
        if labels.get("agent-infra.provider") != provider:
            raise ValueError(
                "image must declare agent-infra.provider=codex; "
                "prepare it with scripts/dev/build_codex_research_image.py"
            )
        if labels.get("agent-infra.codex.version") != "0.154.0":
            raise ValueError("this controller requires a declared Codex 0.154.0 image")
    return str(info["Id"])


def recover_owned_containers(root: Path, *, docker_host: str | None = None) -> tuple[str, ...]:
    """Delete only exact journal + owner label + image matches; fail closed otherwise.

    Caller must hold the controller host lock, or the execution operation lock with
    its supervisor confirmed stopped. Journals precede Docker create, so an
    absent container is safe, including the crash window before create or after rm.
    """
    removed: list[str] = []
    environment = docker_environment(docker_host) if docker_host else None
    for journal in sorted(root.glob("*/ownership.json")):
        if journal.is_symlink() or journal.parent.is_symlink():
            raise ValueError("unsafe Docker ownership journal")
        entry = json.loads(journal.read_text())
        owner, name = entry["owner"], entry["name"]
        if not re.fullmatch(r"[0-9a-f]{32}", owner) or not re.fullmatch(
            r"agent-infra-[0-9a-f]{12}-[0-9a-f]{12}", name
        ):
            raise ValueError("invalid Docker ownership journal")
        result = subprocess.run(
            [
                "docker",
                "container",
                "ls",
                "-a",
                "--filter",
                f"name=^/{name}$",
                "--format",
                "{{.ID}}",
            ],
            capture_output=True,
            text=True,
            timeout=30,
            env=environment,
        )
        if result.returncode:
            raise RuntimeError("cannot verify Docker cleanup; controller remains quarantined")
        if not result.stdout.strip():
            if entry.get("lifecycle") == "creating":
                raise RuntimeError(
                    "Docker create was interrupted before acknowledgement; "
                    "container absence alone cannot prove cleanup; node remains quarantined"
                )
            continue
        info = docker_json(
            "inspect", name, **({"docker_host": docker_host} if docker_host else {})
        )[0]
        if (
            info["Config"].get("Labels", {}).get("agent-infra.owner") != owner
            or info["Image"] != entry["image_id"]
            or info["Name"] != "/" + name
        ):
            raise RuntimeError("container ownership mismatch; refusing cleanup")
        result = subprocess.run(
            ["docker", "rm", "--force", info["Id"]],
            capture_output=True,
            text=True,
            timeout=30,
            env=environment,
        )
        if result.returncode:
            raise RuntimeError("owned container cleanup failed; resources remain quarantined")
        verify = subprocess.run(
            [
                "docker",
                "container",
                "ls",
                "-a",
                "--filter",
                f"id={info['Id']}",
                "--format",
                "{{.ID}}",
            ],
            capture_output=True,
            text=True,
            timeout=30,
            env=environment,
        )
        if verify.returncode or verify.stdout.strip():
            raise RuntimeError("container absence could not be proven")
        write_ownership(journal, entry | {"lifecycle": "removed"})
        removed.append(name)
    return tuple(removed)
