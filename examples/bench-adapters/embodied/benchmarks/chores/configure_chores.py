"""Prepare, build and register the published CHORES small and large validation suites."""

import argparse
import gzip
import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import zipfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))

from adapter import digest, file_digest
from native_runtime import build_native_image, check_policy_source, image_id, require_image, write_benchmark
from orbit_embodied.assets import tree_digest
from orbit_embodied.chores import (
    FPS, ROOT, SUITES, horizon, house_asset_ids, read_asset_manifest, read_catalog, semantic_profile,
)


SOURCE = {"repository": "https://github.com/JiahengHu/FLaRe",
          "commit": "656f46ab332b09490d30bc62b9fb58b7b4ecfd0d"}
CATALOG_REVISIONS = {"chores-small": "771a5d65eea631355649e9ba22b920f0bf052e24",
                     "chores-large": "da0b6a48c9e1abf26352aff51f04a13735053897"}
THOR = "thor-CloudRendering-966bd7758586e05d18f6181f459c0e90ba318bec"
BASE = "pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime"
DATASET = "chores-procthor-objaverse"
WORDNET = {
    "wordnet.zip": "sha256:cbda5ea6eef7f36a97a43d4a75f85e07fccbb4f23657d27b4ccbc93e2646ab59",
    "wordnet2022.zip": "sha256:5ccbb3382b9d147d4acac12645b3d6f375d1f5e4cd037fedadef74d069a8ee3f",
}
DOCKERFILE = HERE / "chores.Dockerfile"
RELEASE = HERE / "release.json"
BENCHMARK_FILES = ("LICENSE", "environment", "tasks", "utils", "online_evaluation", "training", "spoc_constants.py")


def check_payload(root, files):
    for name, checksum in files.items():
        if file_digest(root / name) != checksum:
            raise ValueError("CHORES release file differs: " + name)


def prepare(root, output, release):
    """Materialize the complete annotated evaluation assets under one read-only mount."""
    archive = root / "assets.tar"
    if archive.stat().st_size != release["assetArchiveBytes"]:
        raise ValueError("CHORES asset archive is incomplete or from another release")
    if output.exists():
        raise ValueError("choose a fresh output directory for the CHORES assets")
    assets = release["assets"]
    check_payload(root, release["catalog"])
    check_payload(root, assets)
    catalog = [row for suite in SUITES for row in read_catalog(root, suite).values()]
    house_ids = {row["house_index"] for row in catalog}
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".chores-", dir=output.parent) as directory:
        staged = Path(directory) / "prepared"
        houses = staged / "houses"
        houses.mkdir(parents=True)
        house_manifest = {}
        required = set()
        with gzip.open(root / "val.jsonl.gz", "rt", encoding="utf-8") as stream:
            for index, text in enumerate(stream):
                if index in house_ids:
                    row = json.loads(text)
                    if row is None:
                        raise ValueError(f"CHORES validation house {index} is missing")
                    ids = sorted(set(house_asset_ids(row["objects"])))
                    required.update(ids)
                    (houses / f"{index}.json").write_text(text, encoding="utf-8")
                    house_manifest[str(index)] = {"digest": digest(row), "assetIds": ids}
        if len(house_manifest) != len(house_ids):
            raise ValueError("CHORES release is missing a required house")
        subprocess.run(["tar", "-xf", str(archive), "-C", str(staged)], check=True)
        (staged / "processed_2023_07_28").rename(staged / "assets")
        with gzip.open(root / "annotations.json.gz", "rt", encoding="utf-8") as stream:
            published = json.load(stream)
        object_digests = {}
        for uid in sorted(required):
            asset = staged / "assets" / uid
            if asset.is_symlink():
                raise ValueError("CHORES object asset must be a regular directory: " + uid)
            if not asset.exists() and uid not in published:
                # Unity provides native objects that do not have a procedural asset directory.
                object_digests[uid] = None
                continue
            if not any((asset / (uid + suffix)).is_file() for suffix in (".pkl.gz", ".msgpack.gz", ".json")):
                raise ValueError("CHORES asset archive lacks object " + uid)
            object_digests[uid] = tree_digest(asset)
        (staged / "manifest.json").write_text(json.dumps({"version": 2, "inputs": assets,
                                                        "houses": house_manifest, "objectDigests": object_digests},
                                                        sort_keys=True) + "\n")
        staged.rename(output)


def reference(source, root, prepared, suite, release):
    files = {name: checksum for name, checksum in release["catalog"].items() if name.startswith(suite + "/")}
    check_payload(root, files)
    catalog = read_catalog(root, suite)
    manifest = read_asset_manifest(prepared)
    if any(manifest["inputs"].get(name) != checksum for name, checksum in release["assets"].items()):
        raise ValueError("CHORES asset bundle was prepared from different releases")
    houses = {str(row["house_index"]) for row in catalog.values()}
    house_digests = {index: manifest["houses"][index]["digest"] for index in sorted(houses)}
    room_visit_rooms = {}
    for row in catalog.values():
        if row["task_type"] != "SimpleExploreHouse":
            continue
        index = str(row["house_index"])
        if index not in room_visit_rooms:
            house = json.loads((prepared / "houses" / f"{index}.json").read_text(encoding="utf-8"))
            if digest(house) != house_digests[index]:
                raise ValueError("CHORES RoomVisit house differs from the prepared release: " + index)
            room_visit_rooms[index] = sorted({room["id"] for room in house["rooms"]})
        if len(room_visit_rooms[index]) != row["num_rooms_in_house"]:
            raise ValueError("CHORES RoomVisit room count differs from the catalog: " + index)
    profile = semantic_profile()
    return {
        "id": suite + "/1", "scoreName": "CHORES native task success", "scoreErrors": "exclude",
        "reference": {"evaluation": SOURCE, "catalogRevision": CATALOG_REVISIONS[suite],
                      "catalogFiles": files, "unity": release["thor"],
                      "files": {name: file_digest(source / name) for name in (
                          "online_evaluation/max_episode_configs.py", "tasks/multi_task_eval_sampler.py")}},
        "benchmarkProfile": profile,
        "observationMap": {name: name for name in profile["observations"] if name != "navigation_pose"},
        "parameters": {"replanSteps": 1, "settleSteps": 0, "renderSize": 224, "successRule": "last"},
        "environment": {"kind": "chores", "environmentSeed": 0, "horizons": {
                            task: horizon(row["task_type"]) for task, row in catalog.items()},
                        "controlHz": FPS, "catalog": catalog, "houses": house_digests, "tasks": list(catalog),
                        "roomVisitRooms": room_visit_rooms,
                        "taskTitles": {task: row["natural_language_spec"] for task, row in catalog.items()},
                        "taskTags": {task: {"taskType": row["task_type"], "scene": str(row["house_index"])}
                                     for task, row in catalog.items()},
                        "initialStateCounts": dict.fromkeys(catalog, 1),
                        "initialStateDigests": {task: digest(row) for task, row in catalog.items()},
                        "assets": {"dataset": DATASET, "target": str(ROOT), "digest": digest(manifest)}},
    }


def manifest(base, release):
    return {"kind": "chores", "sources": {"flare": SOURCE["commit"]}, "base": image_id(base),
            "dockerfile": file_digest(DOCKERFILE), "unity": release["thor"], "wordnet": WORDNET,
            "annotations": release["assets"]["annotations.json.gz"], "entrypoint": ["python"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--base-image", default=BASE)
    parser.add_argument("--downloads", type=Path)
    parser.add_argument("--assets", type=Path)
    parser.add_argument("--unity-zip", type=Path)
    parser.add_argument("--wordnet", type=Path)
    parser.add_argument("--annotations", type=Path)
    parser.add_argument("--output-dir", type=Path)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--prepare-assets", action="store_true")
    operation.add_argument("--build-tag")
    operation.add_argument("--benchmark-image")
    args = parser.parse_args()
    release = json.loads(RELEASE.read_text())
    if args.prepare_assets:
        if args.downloads is None or args.assets is None:
            parser.error("--prepare-assets requires --downloads and --assets")
        prepare(args.downloads, args.assets, release)
        return
    if args.source is None:
        parser.error("--source is required for build or registration")
    check_policy_source(args.source, SOURCE)
    build = manifest(args.base_image, release)
    if args.build_tag:
        if args.unity_zip is None or file_digest(args.unity_zip) != release["thor"]:
            parser.error("--unity-zip must match the pinned CloudRendering build")
        if args.annotations is None or file_digest(args.annotations) != release["assets"]["annotations.json.gz"]:
            parser.error("--annotations must match the pinned annotation archive")
        if args.wordnet is None:
            parser.error("--build-tag requires --wordnet")
        check_payload(args.wordnet, WORDNET)
        with tempfile.TemporaryDirectory(prefix="orbit-chores-thor-") as directory:
            extracted = Path(directory) / "unity"
            annotations = Path(directory) / "annotations"
            annotations.mkdir()
            (annotations / "annotations.json.gz").write_bytes(args.annotations.read_bytes())
            with zipfile.ZipFile(args.unity_zip) as archive:
                archive.extractall(extracted)
                for entry in archive.infolist():
                    path = extracted / entry.filename
                    if path.is_file() and stat.S_IMODE(entry.external_attr >> 16) & stat.S_IXUSR:
                        path.chmod(0o755)
            (extracted / THOR).chmod(0o755)
            build_native_image(args.build_tag, "flare", args.source, SOURCE, DOCKERFILE, build, BENCHMARK_FILES,
                               extra_contexts=(("thor", extracted), ("wordnet", args.wordnet), ("annotations", annotations)),
                               build_args=("BENCHMARK_BASE=" + args.base_image,))
        return
    if args.downloads is None or args.assets is None or args.output_dir is None:
        parser.error("--benchmark-image requires --downloads, --assets and --output-dir")
    image = require_image(args.benchmark_image, build)
    for suite in SUITES:
        write_benchmark(args.output_dir, suite, args.source, image, "vulkan", "python",
                        reference(args.source, args.downloads, args.assets, suite, release), gpu_mem=12, suite=suite)


if __name__ == "__main__":
    main()
