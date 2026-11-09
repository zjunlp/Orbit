"""Build and check the pinned RoboCasa v0.2 simulator image."""

import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from adapter import HERE, check_source, file_digest, pinned


ROBOCASA = {"repository": "https://github.com/robocasa/robocasa", "commit": "756598a5be52e052339bb2d957426e39015c2afb"}
ROBOSUITE = {"repository": "https://github.com/ARISE-Initiative/robosuite",
             "commit": "1a8701b90c07c6595ace4af9935d7c5ebe1baed3"}
MANIFEST_LABEL = "orbit.reference.native-runtime"


def robocasa_sources():
    return {"robocasa": ROBOCASA, "robosuite": ROBOSUITE}


def runtime_manifest(kind, sources):
    return {
        "kind": kind,
        "sources": {name: source["commit"] for name, source in sources.items()},
        "dockerfile": file_digest(HERE / (kind + ".Dockerfile")),
        "entrypoint": ["python"],
    }


def require_image(image, manifest):
    record, = json.loads(subprocess.check_output(["docker", "image", "inspect", image], text=True))
    config = record["Config"]
    label = (config.get("Labels") or {}).get(MANIFEST_LABEL)
    try:
        build = json.loads(label) if label is not None else None
    except (TypeError, ValueError):
        build = None
    if build != manifest or config.get("Entrypoint") != manifest["entrypoint"]:
        raise ValueError("expected the pinned " + manifest["kind"] + " simulator image built with native_runtime.py")
    if not pinned(record["Id"]):
        raise ValueError("runtime image must have an immutable content identity")
    return record["Id"]


def export_source(source, expected, target, paths):
    check_source(source, expected, {})
    target.mkdir()
    archive = target.parent / "source.tar"
    subprocess.run(["git", "-C", str(source), "archive", "--format=tar", "--output", str(archive),
                    expected["commit"], "--", *paths], check=True)
    subprocess.run(["tar", "-xf", str(archive), "-C", str(target)], check=True)
    archive.unlink()


def build(args):
    sources = robocasa_sources()
    inputs = {"robocasa": (args.source, ["robocasa"]),
              "robosuite": (args.robosuite_source, ["robosuite"])}
    manifest = runtime_manifest(args.recipe, sources)
    with tempfile.TemporaryDirectory(prefix="orbit-native-image-") as temporary:
        root = Path(temporary)
        contexts = []
        for name, (source, paths) in inputs.items():
            export_source(source, sources[name], root / name, paths)
            contexts += ["--build-context", name + "=" + str(root / name)]
        label = MANIFEST_LABEL + "=" + json.dumps(manifest, sort_keys=True, separators=(",", ":"))
        subprocess.run(["docker", "build", "--label", "orbit.task=embodied-eval", "--label", label, *contexts,
                        "-f", str(HERE / (args.recipe + ".Dockerfile")), "-t", args.tag, str(HERE.parents[2])],
                       check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="recipe", required=True)
    robocasa = commands.add_parser("robocasa-v02")
    robocasa.add_argument("--robosuite-source", type=Path, required=True)
    robocasa.add_argument("--source", type=Path, required=True)
    robocasa.add_argument("--tag", required=True)
    build(parser.parse_args())


if __name__ == "__main__":
    main()
