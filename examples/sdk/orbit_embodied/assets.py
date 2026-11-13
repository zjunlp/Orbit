"""Content identities for model weights and normalization assets, without host paths."""

from pathlib import Path

from .binding import digest


COLOSSEUM_ASSET_ROOT = "/colosseum-assets"


def tree_digest(directory):
    import hashlib
    root = Path(directory).resolve()
    entries = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("asset trees must contain regular files, not symbolic links")
        if not path.is_file():
            continue
        checksum = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                checksum.update(chunk)
        entries.append({"path": path.relative_to(root).as_posix(), "size": path.stat().st_size,
                        "digest": "sha256:" + checksum.hexdigest()})
    if not entries:
        raise ValueError("asset directory is empty or missing")
    return digest(entries)
