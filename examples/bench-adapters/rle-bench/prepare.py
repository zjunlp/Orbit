#!/usr/bin/env python3
"""Prepare official source assets and Docker images; never launch a benchmark trial."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
from urllib.parse import urlsplit

from adapter import REVISION, catalog, checked_root, prepared_digest

GENERATORS = {
    "task01": "build_levels.py", "task02": "build_groups.py", "task03": "build_levels.py",
    "task04": "build_tasks.py", "task05": "build_subtasks.py",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkout", type=Path)
    parser.add_argument("--catalog", action="store_true")
    parser.add_argument("--task", choices=("task07", "task08"))
    parser.add_argument("--build", action="store_true")
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        parser.error("Python 3.11+ is required by the upstream task generators")
    if not args.catalog and not args.task:
        parser.error("choose --catalog and/or --task")
    if args.build and not args.task:
        parser.error("--build requires --task")
    root = checked_root({"benchmark": {"path": str(args.checkout)}})
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}

    def run(argv):
        subprocess.run(argv, cwd=root, env=env, check=True)

    build = ["docker", "build", *shlex.split(os.environ.get("ORBIT_RLE_BUILD_ARGS", "")),
             "--label", "orbit.task=embodied-harness-benchmarks"]
    retries = int(os.environ.get("ORBIT_RLE_APT_RETRIES", "0"))
    if not 0 <= retries <= 10:
        parser.error("ORBIT_RLE_APT_RETRIES must be between 0 and 10")

    index = os.environ.get("ORBIT_RLE_PIP_INDEX_URL", "")
    if index:
        parsed = urlsplit(index)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            parser.error("ORBIT_RLE_PIP_INDEX_URL must be a public HTTP(S) index without credentials or query parameters")

    def dockerfile(task, role):
        source = root / "tasks" / task / ("environment" if role == "agent" else "tests") / "Dockerfile"
        if not retries and not index:
            return source
        text = source.read_text()
        if retries:
            text = text.replace("apt-get update", f"apt-get -o Acquire::Retries={retries} update")
            text = text.replace("apt-get install", f"apt-get -o Acquire::Retries={retries} install")
        if index:
            text = text.replace("pip install --no-cache-dir", f"pip install --index-url {shlex.quote(index)} --no-cache-dir")
        destination = root / "orbit-build" / f"{task}-{role}.Dockerfile"
        destination.parent.mkdir(mode=0o700, exist_ok=True)
        destination.write_text(text)
        return destination

    if args.catalog:
        for family, generator in GENERATORS.items():
            run([sys.executable, str(root / "tasks" / family / generator), "--emit-all"])
        catalog(root)
    if args.task:
        task = args.task
        run([sys.executable, str(root / "tasks" / task / "build_assets.py")])
        if args.build:
            dockerfiles = {role: dockerfile(task, role) for role in ("agent", "verifier")}
            run([*build, "-f", str(dockerfiles["agent"]), "-t", f"rlebench-{task}-agent:dev", f"tasks/{task}/environment"])
            context = f"tasks/{task}/tests" if task == "task07" else "."
            run([*build, "-f", str(dockerfiles["verifier"]), "-t", f"rlebench-{task}-verifier:dev", context])
            path = root / "orbit-images.json"
            lock = json.loads(path.read_text()) if path.exists() else {"revision": REVISION, "images": {}}
            if lock["revision"] != REVISION:
                raise ValueError("existing image map has a different upstream revision")
            digest = prepared_digest(root, task)
            for role in ("agent", "verifier"):
                tag = f"rlebench-{task}-{role}:dev"
                result = subprocess.run(["docker", "image", "inspect", "--format", "{{.Id}}", tag],
                                        capture_output=True, text=True, check=True)
                lock["images"][tag] = result.stdout.strip()
                lock.setdefault("inputs", {})[tag] = digest
                lock.setdefault("dockerfiles", {})[tag] = hashlib.sha256(dockerfiles[role].read_bytes()).hexdigest()
                lock.setdefault("downloadRetries", {})[tag] = retries
                lock.setdefault("packageIndex", {})[tag] = index or "https://pypi.org/simple"
            path.write_text(json.dumps(lock, indent=2) + "\n")
    catalog(root)
    (root / "orbit-catalog.json").write_text(json.dumps(
        {"revision": REVISION, "digest": prepared_digest(root)}, indent=2) + "\n")


if __name__ == "__main__":
    main()
