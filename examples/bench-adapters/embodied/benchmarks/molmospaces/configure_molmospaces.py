"""Build and register the documented MolmoSpaces MS and MolmoBot tracks."""

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
MB_VERSIONS = {**VERSIONS, "benchmarks": {"molmospaces-bench-v2": "20260415"},
               "scenes": {"refs": "20250923", "procthor-10k-val": "20251217_with_occupancy",
                          "procthor-objaverse-val": "20251205_with_occupancy"}}
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
MB_CATALOG_ROOT = "benchmarks/molmospaces-bench-v2"
PICK_V2 = ("procthor-objaverse/FrankaPickHardBench/FrankaPickHardBench_20260206_json_benchmark",
           "9bc5e132bff625bc4464de91c5434fd8ae1496547cb685a123fd5f06aabb84d5", 1000, 20)
MB_TRACKS = {
    "pick-v1-5": ("procthor-10k/FrankaPickDroidMiniBench/FrankaPickDroidMiniBench_json_benchmark_20251231",
                  "c22a7e4262d0b9e2fa073cba0fe4713f7f7a45235332de77149ee771822ca42b", 1000, 20),
    "pick-v2-classic": PICK_V2,
    "pick-v2-filament": PICK_V2,
    "pick-v2-rand-cam": PICK_V2,
    "pnp-v2": ("procthor-objaverse/FrankaPickandPlaceHardBench/FrankaPickandPlaceHardBench_20260206_json_benchmark",
               "aaaa909a9c2598163d3365220cb06bfdceccc91842d8ba006dd59cc0b2dadb92", 1000, 40),
    "pnp-next-to-v2": ("procthor-objaverse/FrankaPickandPlaceNextToHardBench/FrankaPickandPlaceNextToHardBench_20260305_json_benchmark",
                       "aaa121c71a6a5a575406e471e3202ba1ac0cd96049943aa9b7788cbdcbcc78a0", 1000, 30),
    "pnp-color-v2": ("procthor-objaverse/FrankaPickandPlaceColorHardBench/FrankaPickandPlaceColorHardBench_20260304_json_benchmark",
                     "5c6cf766d18cd4b5d7681c57ae41706d8beb8f0af2e08a6a44c9352eace3a444", 1000, 40),
}
MB_CLASSIC = ("pick-v1-5", "pick-v2-classic")
FILAMENT_WHEEL = "mujoco-3.7.1-cp311-cp311-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl"
FILAMENT_DIGEST = "sha256:3dd1c405ba9a7fc3081717ffb9f94c35d37709596b0caaaab8dfcd0fc42afa17"
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


def filament_manifest():
    return {"kind": "molmospaces-filament", "sources": {"molmospaces": SOURCE["commit"]},
            "wheel": FILAMENT_DIGEST,
            "dockerfile": file_digest(Path(__file__).with_name("molmospaces-filament.Dockerfile")),
            "vulkanIcd": file_digest(Path(__file__).with_name("nvidia-egl-icd.json")),
            "entrypoint": ["python"]}


def build_filament(source, tag, base):
    require_image(base, manifest())
    wheel = source / "bin/wheels" / FILAMENT_WHEEL
    if file_digest(wheel) != FILAMENT_DIGEST:
        raise ValueError("MolmoSpaces Filament wheel differs from the pinned release")
    with tempfile.TemporaryDirectory(prefix="orbit-molmospaces-filament-") as temporary:
        shutil.copyfile(wheel, Path(temporary) / wheel.name)
        label = MANIFEST_LABEL + "=" + json.dumps(filament_manifest(), separators=(",", ":"))
        subprocess.run(["docker", "build", "--label", "orbit.task=embodied-eval", "--label", label,
                        "--build-context", f"wheel={temporary}", "--build-arg", f"MOLMOSPACES_BASE={base}",
                        "-f", str(Path(__file__).with_name("molmospaces-filament.Dockerfile")),
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


def register(source, assets, output, image, renderer, *, molmobot=False, filament=None):
    subprocess.run(["git", "-C", str(source), "diff", "--quiet", SOURCE["commit"], "--", *REFERENCE_FILES],
                   check=True)
    versions = json.loads((assets / "assets" / RESOURCE_MANIFEST).read_text())
    expected_versions = MB_VERSIONS if molmobot else VERSIONS
    if versions != expected_versions:
        raise ValueError("prepare the pinned MolmoSpaces resource bundle for the selected suite")
    if molmobot:
        manifest_path = assets / "assets/orbit-scene-objects.json"
        if not manifest_path.is_file():
            raise ValueError("prepare the MolmoBot v2 resource bundle with its scene object dependencies")
        scene_objects = json.loads(manifest_path.read_text())
        if not scene_objects:
            raise ValueError("MolmoBot v2 scene object manifest is empty")
        for path in map(Path, scene_objects):
            if path.parts[:2] != ("objects", "objaverse") or ".." in path.parts or not (assets / "assets" / path).is_file():
                raise ValueError(f"MolmoBot v2 scene object asset is missing or invalid: {path}")
    cached = json.loads((assets / "cache" / RESOURCE_MANIFEST).read_text())
    for data_type, sources in expected_versions.items():
        for name, version in sources.items():
            if version not in cached.get(data_type, {}).get(name, ()):
                raise ValueError(f"MolmoSpaces asset cache lacks {data_type}/{name} {version}")
            if not (assets / "assets" / data_type / name).is_dir():
                raise ValueError(f"MolmoSpaces asset bundle lacks {data_type}/{name}")
    catalogs = {}
    catalog_root = MB_CATALOG_ROOT if molmobot else CATALOG_ROOT
    for task, (directory, sha, count, duration) in (MB_TRACKS if molmobot else TRACKS).items():
        relative = f"{catalog_root}/{directory}/benchmark.json"
        catalog = assets / "assets" / relative
        checksum = "sha256:" + sha
        if file_digest(catalog) != checksum:
            raise ValueError("MolmoSpaces benchmark JSON differs from the published catalog: " + task)
        catalogs[task] = (relative, checksum, count, round(duration * 1000 / POLICY_MS))

    asset_digest = tree_digest(assets)
    upstream = {"evaluation": SOURCE, "files": {name: file_digest(source / name) for name in REFERENCE_FILES}}
    impl = implementation_digest()
    for task, (relative, checksum, count, horizon) in catalogs.items():
        name = "molmospaces-" + task + "-native"
        semantic = profile()
        front = "randomized_zed2_analogue_1" if task == "pick-v2-rand-cam" else None
        if front:
            semantic["id"] = "molmospaces-franka-droid-exocentric/1"
            semantic["observations"]["front_rgb"]["camera"] = front
        backend = "filament" if molmobot and task not in MB_CLASSIC else "classic"
        reference = {
            "id": name + "/1",
            "environment": {"kind": "molmospaces", "tasks": [task], "horizon": horizon,
                            "taskTitles": {task: TRACK_TITLES.get(task, task)},
                            "environmentSeed": 42, "initialStateCounts": {task: count},
                            "initialStateDigests": {task: checksum}, "catalog": relative,
                            "assets": {"dataset": "molmospaces-mb-v2-assets" if molmobot else DATASET,
                                       "target": ROOT, "digest": asset_digest}},
            "parameters": {"controlHz": 1000 / POLICY_MS, "settleSteps": 0, "replanSteps": 8,
                           "policyDtMs": POLICY_MS, "ctrlDtMs": 2, "simDtMs": 2,
                           "renderSize": 224, "resizeSize": 224, "endOnSuccess": True},
            "reference": upstream, "benchmarkProfile": semantic,
            "observationMap": {key: key for key in semantic["observations"]},
            "scoreName": "MolmoBot v2 final oracle success" if molmobot else "MolmoSpaces MS final oracle success",
            "scoreUnit": "sample",
        }
        if molmobot:
            reference["environment"]["renderBackend"] = backend
        if front:
            reference["environment"]["frontCamera"] = front
        track_image = filament if backend == "filament" else image
        track_renderer = "egl" if backend == "filament" else renderer
        benchmark = {
            "name": name, "path": str(source), "adapter": str(HERE / "adapter.py"),
            "config": {"image": track_image, "python": "/usr/local/bin/python", "renderer": track_renderer,
                       "reference": json.dumps(reference, separators=(",", ":")), "profileDigest": digest(reference),
                       "implementationDigest": impl,
                       **({"simGpus": "1", "simGpuMemGB": "6"} if track_renderer == "egl" else {})},
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
    operation.add_argument("--build-filament")
    operation.add_argument("--prepare-assets", metavar="IMAGE")
    operation.add_argument("--benchmark-image")
    parser.add_argument("--assets", type=Path)
    parser.add_argument("--suite", choices=("ms-v1", "mb-v2"), default="ms-v1")
    parser.add_argument("--base-image", help="Classic runtime used to build the Filament image")
    parser.add_argument("--filament-image", help="Filament runtime for registering MB v2")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--renderer", choices=("osmesa", "egl"), default="osmesa")
    args = parser.parse_args()
    source = args.source.resolve()
    check_source(source, SOURCE, {})
    if args.build_tag:
        build(source, args.build_tag)
        return
    if args.build_filament:
        if not args.base_image:
            parser.error("--build-filament requires --base-image pointing to the classic runtime")
        build_filament(source, args.build_filament, args.base_image)
        return
    if not args.assets or (not args.prepare_assets and not args.output_dir):
        parser.error("asset preparation requires --assets and registration also requires --output-dir")
    assets = args.assets.resolve()
    image = require_image(args.prepare_assets or args.benchmark_image, manifest())
    molmobot = args.suite == "mb-v2"
    if args.prepare_assets:
        assets.mkdir(parents=True, exist_ok=True)
        prepare_script = Path(__file__).resolve().with_name("prepare_molmospaces.py")
        catalog_root = MB_CATALOG_ROOT if molmobot else CATALOG_ROOT
        tracks = MB_TRACKS if molmobot else TRACKS
        catalogs = sorted({f"{catalog_root}/{row[0]}/benchmark.json" for row in tracks.values()})
        subprocess.run(["docker", "run", "--rm", "--label", "orbit.task=embodied-eval",
                        "--user", f"{os.getuid()}:{os.getgid()}",
                        "--mount", f"type=bind,src={assets},dst={ROOT}",
                        "--mount", f"type=bind,src={prepare_script},dst=/prepare_molmospaces.py,readonly",
                        "-e", "MLSPACES_CACHE_LOCK=True", image, "/prepare_molmospaces.py",
                        json.dumps(MB_VERSIONS if molmobot else VERSIONS), json.dumps(catalogs)], check=True)
        return
    if molmobot and not args.filament_image:
        parser.error("MB v2 registration requires --filament-image")
    filament = require_image(args.filament_image, filament_manifest()) if molmobot else None
    register(source, assets, args.output_dir, image, args.renderer, molmobot=molmobot, filament=filament)


if __name__ == "__main__":
    main()
