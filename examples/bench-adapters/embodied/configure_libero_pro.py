"""Build and register the twenty native LIBERO-PRO leaderboard conditions."""

import argparse
import json
from pathlib import Path
import subprocess
import tempfile

from adapter import HERE, check_source, digest, file_digest, implementation_digest
from configure_groot import image_id
from native_runtime import MANIFEST_LABEL, export_source, require_image
from orbit_embodied.libero_pro_catalog import INITIAL_STATES, MODES, SCOPES, TASK_ROOT
from orbit_embodied.libero_suites import HORIZONS, LABELS


SOURCE = {"repository": "https://github.com/Zxy-MLlab/LIBERO-PRO",
          "commit": "eafdb809426b13153aa1e4c42d6601844217dfec"}
SOURCE_FILES = ("evaluation_config.yaml", "perturbation.py", "notebooks/generate_init_states.py",
                "libero/libero/benchmark/libero_suite_task_map.py", "libero/libero/envs/env_wrapper.py")


def build(args, manifest):
    with tempfile.TemporaryDirectory(prefix="orbit-libero-pro-") as directory:
        source = Path(directory) / "source"
        export_source(args.source, SOURCE, source, ("libero/libero", "libero_ood", "perturbation.py",
                                                    "evaluation_config.yaml"))
        label = MANIFEST_LABEL + "=" + json.dumps(manifest, sort_keys=True, separators=(",", ":"))
        subprocess.run(["docker", "build", "--label", "orbit.task=embodied-eval", "--label", label,
                        "--build-context", "libero_pro=" + str(source), "--build-arg", "BENCHMARK_BASE=" + args.base_image,
                        "-f", str(HERE / "libero-pro.Dockerfile"), "-t", args.build_tag, str(HERE.parents[2])], check=True)


def register(args, image):
    catalog = json.loads(subprocess.check_output([
        "docker", "run", "--rm", "--network", "none", "--label", "orbit.task=embodied-eval",
        image, "-B", "-c", f"print(open({(TASK_ROOT + '/catalog.json')!r}).read())",
    ], text=True))
    if set(catalog) != {suite + "_" + mode for suite, mode in SCOPES} or any(len(rows) != 10 for rows in catalog.values()):
        raise ValueError("unexpected LIBERO-PRO leaderboard catalog")
    recipe = json.loads((HERE / "profiles/openvla-libero.json").read_text())
    source_files = (*SOURCE_FILES, *(path.relative_to(args.source).as_posix()
                                     for path in sorted((args.source / "libero_ood").glob("*.yaml"))))
    files = {name: file_digest(args.source / name) for name in source_files}
    implementation = implementation_digest()
    for suite, mode in SCOPES:
        entries = {suite + ":" + task: row for task, row in catalog[suite + "_" + mode].items()}
        condition = MODES[mode].lower()
        name = f"libero-pro-{LABELS[suite]}-{condition}-native"
        environment = {"kind": "libero-pro", "suite": suite, "perturbation": mode,
                       "environmentSeed": 0, "tasks": list(entries), "horizon": HORIZONS[suite],
                       "initialStateCounts": {task: INITIAL_STATES for task in entries},
                       "initialStateDigests": {task: row["digest"] for task, row in entries.items()},
                       "taskTitles": {task: row["instruction"] for task, row in entries.items()},
                       "taskTags": {task: {"perturbation": condition,
                                           "perturbationApplied": str(row["applied"]).lower()}
                                    for task, row in entries.items()}}
        reference = {"id": name + "/1", "environment": environment,
                     "parameters": recipe["parameters"],
                     "reference": {"evaluation": SOURCE, "files": files,
                                   "preparation": file_digest(HERE / "prepare_libero_pro.py")},
                     "benchmarkProfile": {**recipe["benchmarkProfile"], "id": "libero-pro-panda-raw/1"},
                     "observationMap": recipe["observationMap"], "scoreName": name + " success"}
        benchmark = {"name": name, "path": str(args.source.resolve()), "adapter": str(HERE / "adapter.py"), "config": {
            "image": image, "python": "/.venv/bin/python", "renderer": "egl" if args.share_gpu else "osmesa",
            **({"simGpus": "1", "simGpuMemGB": "4"} if args.share_gpu else {}),
            "reference": json.dumps(reference, separators=(",", ":")),
            "profileDigest": digest(reference), "implementationDigest": implementation,
        }}
        output = args.output_dir / (LABELS[suite] + "-" + condition)
        output.mkdir(parents=True, exist_ok=True)
        for filename, value in (("benchmark.json", benchmark), ("reference.json", reference)):
            (output / filename).write_text(json.dumps(value, indent=2) + "\n")
        print(name, len(entries), "tasks")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--base-image", required=True)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--share-gpu", action="store_true")
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--build-tag")
    operation.add_argument("--benchmark-image")
    args = parser.parse_args()
    check_source(args.source, SOURCE, {})
    subprocess.run(["git", "-C", str(args.source), "diff", "--quiet", "HEAD", "--"], check=True)
    manifest = {"kind": "libero-pro", "source": SOURCE["commit"], "base": image_id(args.base_image),
                "dockerfile": file_digest(HERE / "libero-pro.Dockerfile"),
                "prepare": file_digest(HERE / "prepare_libero_pro.py"), "entrypoint": ["/.venv/bin/python"]}
    if args.build_tag:
        build(args, manifest)
    elif args.output_dir:
        register(args, require_image(args.benchmark_image, manifest))
    else:
        parser.error("--output-dir is required when registering")


if __name__ == "__main__":
    main()
