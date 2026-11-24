"""Source layout for direct LIBERO checkouts."""

import subprocess


LIBERO_SUBMODULE = "third_party/libero/"


def checkout_status(root):
    git = ["git", "-C", str(root)]
    revision = subprocess.check_output([*git, "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output([*git, "status", "--porcelain", "--untracked-files=no"], text=True).strip()
    return revision, bool(dirty)


def require_libero_checkout(root, reference):
    revision, dirty = checkout_status(root)
    if revision != reference["reference"]["libero"]["commit"] or dirty:
        raise ValueError("expected a clean checkout of the pinned official LIBERO revision")


def standalone_profile(reference):
    upstream = reference["reference"]
    files = {name[len(LIBERO_SUBMODULE):]: checksum for name, checksum in upstream["files"].items()
             if name.startswith(LIBERO_SUBMODULE)}
    return {**reference, "reference": {**upstream, "files": files}}


def audit_file(openpi, libero, relative):
    if relative.startswith(LIBERO_SUBMODULE):
        return libero / relative[len(LIBERO_SUBMODULE):]
    return openpi / relative
