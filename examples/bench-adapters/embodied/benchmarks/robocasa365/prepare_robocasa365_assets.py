"""Assemble a read-only RoboCasa365 asset dataset outside the source checkout."""

import argparse
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
from zipfile import ZipFile


def extract(archive, target):
    with ZipFile(archive) as source:
        for entry in source.infolist():
            path = PurePosixPath(entry.filename)
            if path.is_absolute() or ".." in path.parts or stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError("unsafe path in " + archive.name + ": " + entry.filename)
        source.extractall(target)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--robocasa-source", type=Path, required=True)
    parser.add_argument("--archives", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("output already exists")

    archives = [
        (args.archives / name, target) for name, target in (
            ("textures.zip", "."), ("generative_textures.zip", "."), ("fixtures.zip", "."),
            ("objaverse.zip", "objects"), ("aigen_objs.zip", "objects"),
        )
    ]
    for group, count, target in (
        ("fixtures_lightwheel", 17, "fixtures"),
        ("objects_lightwheel", 69, "objects/lightwheel"),
    ):
        parts = sorted((args.archives / group).glob("*.zip"))
        if len(parts) != count:
            parser.error(f"expected {count} archives for {group}, found {len(parts)}")
        archives.extend((part, target) for part in parts)
    if any(not archive.is_file() for archive, _ in archives):
        parser.error("RoboCasa365 asset archives are incomplete")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=args.output.parent) as temporary:
        staging = Path(temporary) / "assets"
        shutil.copytree(args.robocasa_source / "robocasa/models/assets", staging)
        for archive, target in archives:
            extract(archive, staging / target)
        staging.rename(args.output)


if __name__ == "__main__":
    main()
