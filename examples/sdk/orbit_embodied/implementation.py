"""Small source bundles for container drivers and independently versioned verifiers."""

from pathlib import Path
import shutil

from .binding import digest
from .evidence import file_digest, write_json


def archive_implementation(staging, destination):
    staging, destination = Path(staging), Path(destination)
    sources = {"adapter.py": staging / "adapter.py", "run.py": staging / "run.py"}
    for source in (staging / "python/orbit_embodied").glob("*.py"):
        if not source.name.startswith("test_"):
            sources["sdk/" + source.name] = source
    hashes = {}
    for name, source in sorted(sources.items()):
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        hashes[name] = file_digest(target)
    fingerprint = digest(hashes)
    write_json(destination / "manifest.json", {"version": 1, "files": hashes, "digest": fingerprint})
    return fingerprint


def verify_implementation(directory, expected):
    import json
    directory = Path(directory).resolve()
    manifest = json.loads((directory / "manifest.json").read_text())
    if digest(manifest["files"]) != expected or manifest["digest"] != expected:
        raise ValueError("implementation bundle differs from its contract")
    for name, checksum in manifest["files"].items():
        path = directory / name
        if Path(name).is_absolute() or ".." in Path(name).parts or path.is_symlink() or directory not in path.resolve().parents:
            raise ValueError("implementation path escapes its bundle")
        if file_digest(path) != checksum:
            raise ValueError("implementation file digest mismatch: " + name)
