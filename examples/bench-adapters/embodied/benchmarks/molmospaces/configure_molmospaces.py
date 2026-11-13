"""Build and register the four documented MolmoSpaces MS v1 manipulation tracks."""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.request import urlopen
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import HERE, check_source, digest, file_digest, implementation_digest
from native_runtime import MANIFEST_LABEL, export_source, require_image
from orbit_embodied.assets import tree_digest


SOURCE = {"repository": "https://github.com/allenai/molmospaces",
          "commit": "735138876887eb64650742631b8dda841dd264bf"}
ROOT = "/molmospaces"
DATASET = "molmospaces-ms-v1-assets"
WORDNET_SOURCE = "https://raw.githubusercontent.com/nltk/nltk_data/550b6625bcef1f2abff2ff770a5a0d272c9c6b2a/packages/corpora"
WORDNET_DIGESTS = {
    "wordnet.zip": "sha256:cbda5ea6eef7f36a97a43d4a75f85e07fccbb4f23657d27b4ccbc93e2646ab59",
    "wordnet2022.zip": "sha256:5ccbb3382b9d147d4acac12645b3d6f375d1f5e4cd037fedadef74d069a8ee3f",
}
VERSIONS = {
    "benchmarks": {"molmospaces-bench-v1": "20260408"},
    "robots": {"franka_droid": "20260127"},
    "scenes": {"ithor": "20251217_with_occupancy", "refs": "20250923",
               "procthor-10k-val": "20251217_with_occupancy"},
    "objects": {"thor": "20251117", "objaverse": "20260131", "objathor_metadata": "20260129"},
    "grasps": {"droid": "20251116"},
}
TRACKS = {
    "pick-v1-1": ("procthor-10k/FrankaPickDroidMiniBench/FrankaPickDroidMiniBench_json_benchmark_20251231",
                  "d9da37fc44281b86f8518783df5630c8545a05bab1c0febb16dadfea2918e170", 1000, 30),
    "pnp-v1": ("procthor-10k/FrankaPickandPlaceDroidMiniBench/FrankaPickandPlaceDroidMiniBench_20260111_json_benchmark",
               "a6622fc7d93c53f53745d9a6c2805a16f43fa3c4cc31400852837234fae2530e", 1000, 45),
    "open-v1": ("ithor/FrankaOpenDataGenConfig/FrankaOpenDataGenConfig_20260123_json_benchmark",
                "8745b89f28c7199a08f64a88049a1333426f6e8320ae5e01046eb1f129fa30ef", 1000, 30),
    "close-v1": ("ithor/FrankaCloseDataGenConfig/FrankaCloseDataGenConfig_20260123_json_benchmark",
                 "efb6c8f2aa03d21d74f5fa953189f9877f99829bcfb722cc8d6a8ace85c5e559", 915, 30),
}
TRACK_TITLES = {"pick-v1-1": "Pick-v1.1", "pnp-v1": "PnP-v1", "open-v1": "Open-v1", "close-v1": "Close-v1"}
CATALOG_ROOT = "benchmarks/molmospaces-bench-v1"
RESOURCE_MANIFEST = "mjthor_data_type_to_source_to_versions.json"
POLICY_MS = 66
REFERENCE_FILES = (
    "molmo_spaces/data_generation/pipeline.py",
    "molmo_spaces/evaluation/benchmark_schema.py",
    "molmo_spaces/evaluation/eval_main.py",
    "molmo_spaces/evaluation/json_eval_runner.py",
    "molmo_spaces/evaluation/configs/evaluation_configs.py",
    "molmo_spaces/tasks/json_eval_task_sampler.py",
    "molmo_spaces/tasks/task.py",
    "molmo_spaces/tasks/pick_task.py",
    "molmo_spaces/tasks/pick_and_place_task.py",
    "molmo_spaces/tasks/opening_tasks.py",
    "molmo_spaces/policy/learned_policy/pi_policy.py",
    "molmo_spaces/policy/learned_policy/utils.py",
    "molmo_spaces/utils/grasps.py",
)


def manifest():
    return {"kind": "molmospaces", "sources": {"molmospaces": SOURCE["commit"]},
            "wordnet": WORDNET_DIGESTS,
            "dockerfile": file_digest(Path(__file__).resolve().with_name("molmospaces.Dockerfile")), "entrypoint": ["python"]}


def build(source, tag):
    with tempfile.TemporaryDirectory(prefix="orbit-molmospaces-source-") as temporary:
        context = Path(temporary) / "source"
        export_source(source, SOURCE, context, ["pyproject.toml", "README.md", "LICENSE", "molmo_spaces"])
        corpora = Path(temporary) / "wordnet"
        corpora.mkdir()
        for name, checksum in WORDNET_DIGESTS.items():
            path = corpora / name
            with urlopen(f"{WORDNET_SOURCE}/{name}", timeout=60) as response, path.open("wb") as output:
                shutil.copyfileobj(response, output)
            if file_digest(path) != checksum:
                raise ValueError("unexpected WordNet corpus digest: " + name)
        label = MANIFEST_LABEL + "=" + json.dumps(manifest(), sort_keys=True, separators=(",", ":"))
        subprocess.run(["docker", "build", "--label", "orbit.task=embodied-eval", "--label", label,
                        "--build-context", "molmospaces=" + str(context), "--build-context", "wordnet=" + str(corpora),
                        "-f", str(Path(__file__).resolve().with_name("molmospaces.Dockerfile")),
                        "-t", tag, str(HERE.parents[2])], check=True)


def profile():
    observations = {
        name: {"semantic": "rgb", "dtype": "uint8", "layout": "HWC", "shape": [224, 224, 3], "camera": camera}
        for name, camera in (("front_rgb", "droid-shoulder"), ("wrist_rgb", "droid-wrist"))
    }
    observations.update({
        "state.arm": {"semantic": "joint-position", "dtype": "float32", "shape": [7],
                      "frame": "franka-droid-joints", "unit": "radian"},
        "state.gripper": {"semantic": "gripper-position", "dtype": "float32", "shape": [1],
                          "frame": "franka-droid-gripper", "unit": "radian"},
        "instruction": {"semantic": "language-instruction", "dtype": "string", "shape": []},
    })
    action = {"semantic": "absolute-arm-joints-and-binary-gripper", "controller": "joint_position",
              "shape": [8], "frame": "franka-droid-joints", "unit": "radian-and-native-gripper-command",
              "rotation": "absolute-joint-angle", "gripper": "0-open-255-closed",
              "order": [f"joint{i}" for i in range(1, 8)] + ["gripper"]}
    return {"id": "molmospaces-franka-droid/1", "observations": observations, "action": action}


def register(source, assets, output, image, renderer):
    subprocess.run(["git", "-C", str(source), "diff", "--quiet", SOURCE["commit"], "--", *REFERENCE_FILES],
                   check=True)
    versions = json.loads((assets / "assets" / RESOURCE_MANIFEST).read_text())
    if versions != VERSIONS:
        raise ValueError("prepare the pinned MS v1 manipulation resource bundle first")
    cached = json.loads((assets / "cache" / RESOURCE_MANIFEST).read_text())
    for data_type, sources in VERSIONS.items():
        for name, version in sources.items():
            if version not in cached.get(data_type, {}).get(name, ()):
                raise ValueError(f"MolmoSpaces asset cache lacks {data_type}/{name} {version}")
            if not (assets / "assets" / data_type / name).is_dir():
                raise ValueError(f"MolmoSpaces asset bundle lacks {data_type}/{name}")
    catalogs = {}
    for task, (directory, sha, count, duration) in TRACKS.items():
        relative = f"{CATALOG_ROOT}/{directory}/benchmark.json"
        catalog = assets / "assets" / relative
        checksum = "sha256:" + sha
        if file_digest(catalog) != checksum:
            raise ValueError("MolmoSpaces benchmark JSON differs from the published v1 catalog: " + task)
        catalogs[task] = (relative, checksum, count, round(duration * 1000 / POLICY_MS))

    asset_digest = tree_digest(assets)
    upstream = {"evaluation": SOURCE, "files": {name: file_digest(source / name) for name in REFERENCE_FILES}}
    semantic = profile()
    impl = implementation_digest()
    for task, (relative, checksum, count, horizon) in catalogs.items():
        name = "molmospaces-" + task + "-native"
        reference = {
            "id": name + "/1",
            "environment": {"kind": "molmospaces", "tasks": [task], "horizon": horizon,
                            "taskTitles": {task: TRACK_TITLES[task]},
                            "environmentSeed": 42, "initialStateCounts": {task: count},
                            "initialStateDigests": {task: checksum}, "catalog": relative,
                            "assets": {"dataset": DATASET, "target": ROOT, "digest": asset_digest}},
            "parameters": {"controlHz": 1000 / POLICY_MS, "settleSteps": 0, "replanSteps": 8,
                           "policyDtMs": POLICY_MS, "ctrlDtMs": 2, "simDtMs": 2,
                           "renderSize": 224, "resizeSize": 224, "endOnSuccess": True},
            "reference": upstream, "benchmarkProfile": semantic,
            "observationMap": {key: key for key in semantic["observations"]},
            "scoreName": "MolmoSpaces MS final oracle success", "scoreUnit": "sample",
        }
        benchmark = {
            "name": name, "path": str(source), "adapter": str(HERE / "adapter.py"),
            "config": {"image": image, "python": "/usr/local/bin/python", "renderer": renderer,
                       "reference": json.dumps(reference, separators=(",", ":")), "profileDigest": digest(reference),
                       "implementationDigest": impl, **({"simGpus": "1", "simGpuMemGB": "6"} if renderer == "egl" else {})},
        }
        target = output / name
        target.mkdir(parents=True, exist_ok=True)
        for filename, data in (("benchmark.json", benchmark), ("reference.json", reference)):
            (target / filename).write_text(json.dumps(data, indent=2) + "\n")
        print(f"{name}: {count} official episodes")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--build-tag")
    operation.add_argument("--prepare-assets", metavar="IMAGE")
    operation.add_argument("--benchmark-image")
    parser.add_argument("--assets", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--renderer", choices=("osmesa", "egl"), default="osmesa")
    args = parser.parse_args()
    source = args.source.resolve()
    check_source(source, SOURCE, {})
    if args.build_tag:
        build(source, args.build_tag)
        return
    if not args.assets or (not args.prepare_assets and not args.output_dir):
        parser.error("asset preparation requires --assets and registration also requires --output-dir")
    assets = args.assets.resolve()
    image = require_image(args.prepare_assets or args.benchmark_image, manifest())
    if args.prepare_assets:
        assets.mkdir(parents=True, exist_ok=True)
        prepare_script = Path(__file__).resolve().with_name("prepare_molmospaces.py")
        catalogs = [f"{CATALOG_ROOT}/{row[0]}/benchmark.json" for row in TRACKS.values()]
        subprocess.run(["docker", "run", "--rm", "--label", "orbit.task=embodied-eval",
                        "--user", f"{os.getuid()}:{os.getgid()}",
                        "--mount", f"type=bind,src={assets},dst={ROOT}",
                        "--mount", f"type=bind,src={prepare_script},dst=/prepare_molmospaces.py,readonly",
                        "-e", "MLSPACES_CACHE_LOCK=True", image, "/prepare_molmospaces.py",
                        json.dumps(VERSIONS), json.dumps(catalogs)], check=True)
        return
    register(source, assets, args.output_dir, image, args.renderer)


if __name__ == "__main__":
    main()
