"""Content identities for model weights and normalization assets, without host paths."""

from pathlib import Path

from .binding import digest, file_digest


COLOSSEUM_ASSET_ROOT = "/colosseum-assets"


def policy_asset_digests(root, groups):
    """Fingerprint the exact files consumed by a policy, excluding download caches."""
    identities = {}
    for field, paths in groups.items():
        files = {}
        for relative in paths:
            path = root / relative
            if path.is_dir():
                files[relative] = checkpoint_tree_digest(path)
            elif path.is_file():
                files[relative] = file_digest(path)
            else:
                raise ValueError("missing policy asset: " + relative)
        identities[field] = next(iter(files.values())) if field == "normalizationDigest" and len(files) == 1 else digest(files)
    return identities


def tree_digest(directory):
    return _tree_digest(directory, exclude_download_metadata=False)


def checkpoint_tree_digest(directory):
    """Fingerprint a local checkpoint without Hugging Face local-dir download bookkeeping."""
    return _tree_digest(directory, exclude_download_metadata=True)


def _tree_digest(directory, *, exclude_download_metadata):
    import hashlib
    root = Path(directory).resolve()
    entries = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if exclude_download_metadata and (
                relative.parts[:3] == (".cache", "huggingface", "download")
                or relative.parts == (".cache", "huggingface", ".gitignore")):
            continue
        if path.is_symlink():
            raise ValueError("asset trees must contain regular files, not symbolic links")
        if not path.is_file():
            continue
        checksum = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                checksum.update(chunk)
        entries.append({"path": relative.as_posix(), "size": path.stat().st_size,
                        "digest": "sha256:" + checksum.hexdigest()})
    if not entries:
        raise ValueError("asset directory is empty or missing")
    return digest(entries)
