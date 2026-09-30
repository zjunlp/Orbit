"""Bounded source snapshots with Git provenance; datasets remain explicit mounts."""

import json
import os
import shutil
import stat
import subprocess
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from agent_infra.contracts.files import content_digest

_EXCLUDED = {
    ".git",
    ".venv",
    "venv",
    "node_modules",
    "__pycache__",
    ".aws",
    ".ssh",
    ".codex",
    ".claude",
    "data",
    "datasets",
    "weights",
    "checkpoints",
    "outputs",
    "runs",
    ".infra-evidence",
}
_WEIGHTS = {".pt", ".pth", ".safetensors", ".ckpt"}


def _excluded(path: Path) -> bool:
    return (
        any(p in _EXCLUDED or p == ".env" or p.startswith(".env.") for p in path.parts)
        or path.suffix in _WEIGHTS
    )


@contextmanager
def _source_file(root: Path, path: Path) -> Iterator[int]:
    """Walk from a directory descriptor so a concurrent symlink swap cannot escape."""
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        file = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
        try:
            yield file
        finally:
            os.close(file)
    finally:
        os.close(descriptor)


def snapshot_workspace(
    source: Path,
    destination: Path,
    *,
    max_bytes: int = 128 * 1024**2,
    provenance: dict[str, Any] | None = None,
) -> dict[str, Any]:
    source = source.resolve(strict=True)
    if not source.is_dir() or destination.resolve().is_relative_to(source):
        raise ValueError("snapshot destination must be outside the project directory")
    if destination.exists():
        raise ValueError("snapshot already exists")

    def git(*args: str) -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            ["git", "--literal-pathspecs", "-C", str(source), *args],
            capture_output=True,
            timeout=30,
        )

    listed = git("ls-files", "-z", "--cached", "--others", "--exclude-standard")
    if listed.returncode == 0:
        names = sorted(set(os.fsdecode(p) for p in listed.stdout.split(b"\0") if p))
    else:
        names = []
        for directory, children, files in os.walk(source, followlinks=False):
            parent = Path(directory).relative_to(source)
            children[:] = [name for name in children if not _excluded(parent / name)]
            for name in children:
                if (source / parent / name).is_symlink():
                    raise ValueError("snapshot directory symlinks are unsupported")
            names.extend(str(parent / name) for name in files)
            if len(names) > 10000:
                raise ValueError("project has over 10000 source files")
        names.sort()
    if sum(not _excluded(Path(name)) for name in names) > 10000:
        raise ValueError("project has over 10000 files; keep datasets outside the source snapshot")
    metadata: dict[str, Any] = {
        "source": str(source),
        "commit": None,
        "files": [],
        "excluded": [],
        **(provenance or {}),
    }
    if listed.returncode == 0:
        head = git("rev-parse", "HEAD")
        metadata["commit"] = head.stdout.decode().strip() if head.returncode == 0 else None
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = Path(
        tempfile.mkdtemp(prefix=destination.name + ".partial-", dir=destination.parent)
    )
    code, evidence = temporary / "source", temporary / "evidence"
    code.mkdir()
    evidence.mkdir()
    total = 0
    allowed = []
    try:
        for name in names:
            relative = Path(name)
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("invalid snapshot member")
            if _excluded(relative):
                metadata["excluded"].append(name)
                continue
            allowed.append(name)
            path = source / relative
            if not path.exists() and not path.is_symlink():
                continue  # Tracked file deleted in the working tree.
            if path.is_symlink() or path.resolve() != path:
                raise ValueError(f"snapshot symlink is unsupported: {name}")
            with _source_file(source, relative) as descriptor:
                before = os.fstat(descriptor)
                if not stat.S_ISREG(before.st_mode):
                    raise ValueError("snapshot members must be regular files")
                total += before.st_size
                if total > max_bytes:
                    raise ValueError("source exceeds snapshot limit; use data mounts")
                target = code / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("xb") as writer:
                    remaining = before.st_size
                    while remaining:
                        chunk = os.read(descriptor, min(remaining, 1024**2))
                        if not chunk:
                            raise ValueError("source changed while copying; retry submission")
                        writer.write(chunk)
                        remaining -= len(chunk)
                    if os.read(descriptor, 1):
                        raise ValueError("source grew while copying; retry submission")
                    writer.flush()
                    os.fsync(writer.fileno())
                after = os.fstat(descriptor)
                if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                    raise ValueError("source changed while copying; retry submission")
                target.chmod(before.st_mode & 0o777 & ~0o022)
            metadata["files"].append(name)
        if listed.returncode == 0:
            for filename, revision in (
                ("code.patch", ("HEAD",)),
                ("staged.patch", ("--cached",)),
                ("unstaged.patch", ()),
            ):
                patch = (
                    git(
                        "diff",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--binary",
                        *revision,
                        "--",
                        *allowed,
                    ).stdout
                    if allowed
                    else b""
                )
                if len(patch) > max_bytes:
                    raise ValueError("code diff exceeds snapshot limit")
                (evidence / filename).write_bytes(patch)
            metadata["untracked"] = [
                os.fsdecode(p)
                for p in git("ls-files", "-z", "--others", "--exclude-standard").stdout.split(b"\0")
                if p and os.fsdecode(p) in metadata["files"]
            ]
        metadata["digest"] = content_digest(code)
        (evidence / "code.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2))
        for path in evidence.iterdir():
            with path.open("rb") as stream:
                os.fsync(stream.fileno())
        for path in sorted(temporary.rglob("*"), reverse=True) + [temporary]:
            if path.is_dir():
                descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
        temporary.rename(destination)
        descriptor = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        return metadata
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
