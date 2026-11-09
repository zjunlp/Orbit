"""Build and check the pinned RoboCasa v0.2 and RLBench simulator images."""

import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from adapter import HERE, check_source, file_digest, pinned


ROBOCASA = {"repository": "https://github.com/robocasa/robocasa", "commit": "756598a5be52e052339bb2d957426e39015c2afb"}
ROBOSUITE = {"repository": "https://github.com/ARISE-Initiative/robosuite",
             "commit": "1a8701b90c07c6595ace4af9935d7c5ebe1baed3"}
RLBENCH = {"repository": "https://github.com/stepjam/RLBench", "commit": "02720bba4c73fe02eb75df946b8791b806028a9d"}
PYREP = {"repository": "https://github.com/stepjam/PyRep", "commit": "8f420be8064b1970aae18a9cfbc978dfb15747ef"}
RVT = {"repository": "https://github.com/NVlabs/RVT", "commit": "367995a1a2169b6352bf4e8b0ed405890462a3a0"}
RVT_RLBENCH = {"repository": "https://github.com/buttomnutstoast/RLBench",
               "commit": "587a6a0e6dc8cd36612a208724eb275fe8cb4470"}
RVT_PYREP = {**PYREP, "commit": "231a1ac6b0a179cff53c1d403d379260b9f05f2f"}
RVT_PLANNER = "rvt/utils/rlbench_planning.py"
COPPELIASIM_SHA256 = "sha256:512de3a7347387fcc1b12fa675195a912265753f7901808382865bbf51a2a7f8"
MANIFEST_LABEL = "orbit.reference.native-runtime"


def robocasa_sources():
    return {"robocasa": ROBOCASA, "robosuite": ROBOSUITE}


def rlbench_sources(rvt):
    if rvt:
        return {"rlbench": RVT_RLBENCH, "pyrep": RVT_PYREP, "rvt": RVT}
    return {"rlbench": RLBENCH, "pyrep": PYREP}


def runtime_manifest(kind, sources):
    recipe = "robocasa-v02" if kind == "robocasa-v02" else "rlbench"
    manifest = {
        "kind": kind,
        "sources": {name: source["commit"] for name, source in sources.items()},
        "dockerfile": file_digest(HERE / (recipe + ".Dockerfile")),
        "entrypoint": ["python"] if recipe == "robocasa-v02" else ["/usr/local/bin/rlbench-python"],
    }
    if recipe == "rlbench":
        manifest["coppeliasim"] = COPPELIASIM_SHA256
        manifest["launcher"] = file_digest(HERE / "rlbench-python.sh")
    return manifest


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
    if args.recipe == "robocasa-v02":
        kind = args.recipe
        sources = robocasa_sources()
        inputs = {"robocasa": (args.source, ["robocasa"]),
                  "robosuite": (args.robosuite_source, ["robosuite"])}
        target = []
    else:
        if file_digest(args.coppeliasim_archive) != COPPELIASIM_SHA256:
            raise ValueError("CoppeliaSim archive differs from the pinned distribution")
        rvt = args.rvt_source is not None
        kind = "rlbench-rvt18" if rvt else "rlbench-mt100"
        sources = rlbench_sources(rvt)
        inputs = {"rlbench": (args.source, ["rlbench"]), "pyrep": (args.pyrep_source, [])}
        if rvt:
            inputs["rvt"] = (args.rvt_source, [RVT_PLANNER])
        target = ["--target", "rvt-simulator" if rvt else "simulator"]
    manifest = runtime_manifest(kind, sources)
    with tempfile.TemporaryDirectory(prefix="orbit-native-image-") as temporary:
        root = Path(temporary)
        contexts = []
        for name, (source, paths) in inputs.items():
            export_source(source, sources[name], root / name, paths)
            contexts += ["--build-context", name + "=" + str(root / name)]
        if args.recipe == "rlbench":
            simulator = root / "coppeliasim"
            simulator.mkdir()
            subprocess.run(["tar", "-xJf", str(args.coppeliasim_archive), "--strip-components=1", "-C", str(simulator)],
                           check=True)
            contexts += ["--build-context", "coppeliasim=" + str(simulator)]
        label = MANIFEST_LABEL + "=" + json.dumps(manifest, sort_keys=True, separators=(",", ":"))
        subprocess.run(["docker", "build", "--label", "orbit.task=embodied-eval", "--label", label, *target, *contexts,
                        "-f", str(HERE / (args.recipe + ".Dockerfile")), "-t", args.tag, str(HERE.parents[2])],
                       check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="recipe", required=True)
    robocasa = commands.add_parser("robocasa-v02")
    robocasa.add_argument("--robosuite-source", type=Path, required=True)
    rlbench = commands.add_parser("rlbench")
    rlbench.add_argument("--pyrep-source", type=Path, required=True)
    rlbench.add_argument("--coppeliasim-archive", type=Path, required=True)
    rlbench.add_argument("--rvt-source", type=Path)
    for command in (robocasa, rlbench):
        command.add_argument("--source", type=Path, required=True)
        command.add_argument("--tag", required=True)
    build(parser.parse_args())


if __name__ == "__main__":
    main()
