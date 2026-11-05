#!/usr/bin/env python3
"""Download the pinned wheel and extract only the registered data outside the repo."""

import hashlib
import io
from pathlib import Path
import sys
import urllib.request
import zipfile

from adapter import PINS, WHEEL_SHA256, WHEEL_URL


def prepare(destination):
    wheel = urllib.request.urlopen(WHEEL_URL, timeout=120).read()
    if hashlib.sha256(wheel).hexdigest() != WHEEL_SHA256:
        raise ValueError("BFCL wheel sha256 mismatch")
    with zipfile.ZipFile(io.BytesIO(wheel)) as archive:
        for name, expected in PINS.items():
            content = archive.read("bfcl_eval/data/" + name)
            if hashlib.sha256(content).hexdigest() != expected:
                raise ValueError(f"BFCL data sha256 mismatch: {name}")
            path = destination / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists() and path.read_bytes() != content:
                raise ValueError(f"Refusing to overwrite different data: {path}")
            path.write_bytes(content)
    print(f"Prepared {len(PINS)} pinned BFCL data files in {destination}")


if __name__ == "__main__":
    prepare(Path(sys.argv[1]).resolve())
