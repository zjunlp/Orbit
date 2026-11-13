"""Resolve immutable image IDs and build and check pinned native runtimes."""

import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from adapter import HERE, SDK, check_source, digest, file_digest, implementation_digest, pinned


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
RLINF_REVISION = "1bf78980d9339cbc67497eddceb9a1e3a74e2acc"


def image_id(image):
    value = subprocess.check_output(["docker", "image", "inspect", "--format", "{{.Id}}", image], text=True).strip()
    if not pinned(value):
        raise ValueError("runtime image must have an immutable content identity")
    return value


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
        "dockerfile": file_digest(HERE / "benchmarks" / recipe / (recipe + ".Dockerfile")),
        "entrypoint": ["python"] if recipe == "robocasa-v02" else ["/usr/local/bin/rlbench-python"],
    }
    if recipe == "rlbench":
        manifest["coppeliasim"] = COPPELIASIM_SHA256
        manifest["launcher"] = file_digest(HERE / "benchmarks/rlbench/rlbench-python.sh")
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
        raise ValueError("expected the pinned " + manifest["kind"] + " image with a matching build manifest and entrypoint")
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


def build_native_image(tag, kind, source, identity, dockerfile, manifest, source_paths, *, extra_contexts=()):
    with tempfile.TemporaryDirectory(prefix="orbit-" + kind + "-") as temporary:
        context = Path(temporary) / kind
        export_source(source, identity, context, source_paths)
        contexts = ["--build-context", kind + "=" + str(context)]
        for name, path in extra_contexts:
            contexts.extend(["--build-context", name + "=" + str(path)])
        label = MANIFEST_LABEL + "=" + json.dumps(manifest, sort_keys=True, separators=(",", ":"))
        subprocess.run(["docker", "build", "--label", "orbit.task=embodied-eval", "--label", label,
                        *contexts, "-f", str(dockerfile),
                        "-t", tag, str(HERE.parents[2])], check=True)


def read_native_catalog(image, module):
    prefix = "ORBIT_NATIVE_CATALOG="
    code = ("import json; from " + module + " import native_catalog; "
            + f"print({prefix!r} + json.dumps(native_catalog()))")
    output = subprocess.check_output(
        ["docker", "run", "--rm", "--network", "none", "--label", "orbit.task=embodied-eval",
         "--mount", f"type=bind,src={SDK},dst=/orbit-sdk,readonly", "-e", "PYTHONPATH=/orbit-sdk",
         image, "-B", "-c", code], text=True)
    line, = (line for line in output.splitlines() if line.startswith(prefix))
    return json.loads(line[len(prefix):])


def write_benchmark(output_dir, name, source, image, renderer, interpreter, reference, *, gpu_mem=None, suite=None):
    benchmark = {"name": name, "path": str(source.resolve()), "adapter": str(HERE / "adapter.py"),
                 "config": {"image": image, "python": interpreter, "renderer": renderer,
                            "simGpus": "1" if gpu_mem is not None else "0",
                            **({"suite": suite} if suite is not None else {}),
                            **({"simGpuMemGB": str(gpu_mem)} if gpu_mem is not None else {}),
                            "reference": json.dumps(reference, separators=(",", ":")),
                            "profileDigest": digest(reference), "implementationDigest": implementation_digest()}}
    output = output_dir / name
    output.mkdir(parents=True, exist_ok=True)
    for filename, value in (("benchmark.json", benchmark), ("reference.json", reference)):
        (output / filename).write_text(json.dumps(value, indent=2) + "\n")


def check_policy_source(source, expected):
    check_source(source, expected, {})
    status = subprocess.check_output(
        ["git", "-C", str(source), "status", "--porcelain", "--untracked-files=normal"], text=True)
    if status.strip():
        raise ValueError("expected a clean pinned policy checkout: " + expected["repository"])


def policy_manifest(kind, sources, dockerfile, server, *, interpreter="python"):
    return {
        "kind": kind,
        "sources": {name: source["commit"] for name, source in sources.items()},
        "dockerfile": file_digest(dockerfile),
        "server": file_digest(server),
        "sdk": {path.name: file_digest(path) for path in sorted((SDK / "orbit_embodied").glob("*.py"))
                if not path.name.startswith("test_")},
        "entrypoint": [interpreter, "/opt/orbit/" + server.name],
    }


def build_policy_image(args, context_name, source, dockerfile, manifest, *, source_paths=(), extra_contexts=()):
    with tempfile.TemporaryDirectory(prefix="orbit-native-policy-") as temporary:
        context = Path(temporary) / context_name
        export_source(args.source, source, context, source_paths)
        contexts = ["--build-context", context_name + "=" + str(context)]
        for name, path in extra_contexts:
            contexts.extend(["--build-context", name + "=" + str(path)])
        label = MANIFEST_LABEL + "=" + json.dumps(manifest, sort_keys=True, separators=(",", ":"))
        subprocess.run(["docker", "build", "--label", "orbit.task=embodied-eval", "--label", label,
                        *contexts,
                        "--build-arg", "POLICY_BASE=" + args.policy_base,
                        "-f", str(dockerfile), "-t", args.build_tag, str(HERE.parents[2])], check=True)


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
                        "-f", str(HERE / "benchmarks" / args.recipe / (args.recipe + ".Dockerfile")), "-t", args.tag, str(HERE.parents[2])],
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
