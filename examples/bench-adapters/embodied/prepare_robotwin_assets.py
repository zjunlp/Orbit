"""Assemble the assets needed by the pinned RoboTwin demo_clean task."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import tempfile
from zipfile import ZipFile

from adapter import HERE


def extract(archive, expected, prefix, output, extra=()):
    checksum = hashlib.sha256()
    with archive.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(block)
    if "sha256:" + checksum.hexdigest() != expected:
        raise ValueError("RoboTwin asset archive differs from the pinned release: " + archive.name)
    extracted = 0
    with ZipFile(archive) as source:
        for member in source.infolist():
            if member.is_dir() or (not member.filename.startswith(prefix + "/") and member.filename not in extra):
                continue
            name = PurePosixPath(member.filename)
            if ".." in name.parts:
                raise ValueError("unsafe RoboTwin asset path: " + member.filename)
            target = output / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.open(member) as content, target.open("xb") as destination:
                shutil.copyfileobj(content, destination)
            extracted += 1
    if not extracted or any(not (output / path).is_file() for path in extra):
        raise ValueError("RoboTwin archive did not contain the required files for " + prefix)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archives", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    reference = json.loads((HERE / "profiles/robotwin-demo-clean.json").read_text())
    archives = reference["reference"]["assets"]["archives"]
    simulator_root = Path(reference["environment"]["assets"]["target"]).parent
    embodiment = "embodiments/aloha-agilex"
    output = args.output.resolve()
    if output.exists():
        raise ValueError("RoboTwin asset output already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as stage:
        assets = Path(stage) / "assets"
        extract(args.archives / "embodiments.zip", archives["embodiments.zip"], embodiment, assets)
        # The pinned simulator loads these indices at import even in demo_clean.
        extract(args.archives / "objects.zip", archives["objects.zip"], "objects/001_bottle", assets,
                extra=("objects/objaverse/list.json", "objects/same.json"))
        for side in ("left", "right"):
            template = assets / embodiment / f"curobo_{side}_tmp.yml"
            content = template.read_text().replace("${ASSETS_PATH}", str(simulator_root))
            content = content.replace("$ASSETS_PATH", str(simulator_root))
            template.with_name(f"curobo_{side}.yml").write_text(content)
        assets.rename(output)


if __name__ == "__main__":
    main()
