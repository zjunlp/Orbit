"""Build, prepare and register all published HSSD-OV evaluation episodes."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))

from adapter import check_source, digest, file_digest
from native_runtime import build_native_image, check_policy_source, export_source, image_id, require_image, write_benchmark
from orbit_embodied.evidence import write_json
from orbit_embodied.hssd_ov import FPS, HORIZON, ROOT, goal_instruction, read_catalog, semantic_profile


SOURCE = {"repository": "https://github.com/amazon-far/stopwatch",
          "commit": "bda73cbab833dcb72af23d24067bad2b56ca5ef1"}
SIM = {"repository": "https://github.com/facebookresearch/habitat-sim",
       "commit": "2bc5b4573b37202cb44b771ded34d5992a93f795"}
LAB = {"repository": "https://github.com/facebookresearch/habitat-lab",
       "commit": "8c403d6645bd320652ff44c2fb5185f6c208c8ab"}
IMATH = {"repository": "https://github.com/AcademySoftwareFoundation/Imath",
         "commit": "d690a3fcff4e877ead5ae56c7e964595ade8a35e"}
CATALOG_REVISION = "f1a5d5539b0c9584b5ed522a5d5578514444c684"
SCENES_REVISION = "4369cb9876214c7fbebcf552eb532380e4d287e4"
BASE = "pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime"
NAME = "hssd-ov"
SOURCE_PATHS = ("LICENSE", "configs/eval_hssdov.yaml", "stopwatch")
UNUSED_SUBMODULES = {"docs/m.css", "src/deps/bullet3", "src/deps/glfw", "src/deps/rlr-audio-propagation"}
DOCKERFILE = HERE / "hssd-ov.Dockerfile"
RELEASE = HERE / "release.json"


def build_manifest(base):
    return {"kind": NAME, "sources": {key: source["commit"] for key, source in (
        ("stopwatch", SOURCE), ("habitat-sim", SIM), ("habitat-lab", LAB), ("imath", IMATH))},
        "base": image_id(base), "dockerfile": file_digest(DOCKERFILE), "entrypoint": ["python"]}


def checked_catalog(assets, release):
    for name, expected in release["evaluation"].items():
        if file_digest(assets / name) != expected:
            raise ValueError("HSSD-OV evaluation input differs from the published revision: " + name)
    return read_catalog(assets)


def scene_bundle(assets, catalog):
    """Describe the source and derived files without changing the asset directory."""
    scenes = assets / "scenes/hssd-hab"
    templates = {}
    for path in (scenes / "objects").rglob("*.object_config.json"):
        name = path.name.removesuffix(".object_config.json")
        if name in templates:
            raise ValueError("Duplicate HSSD object template " + name)
        templates[name] = path.relative_to(assets)
    derived = scenes / "derived_scenes"
    files = set()
    scene_payloads = {}
    scene_dependencies = {}
    for name in sorted({Path(row["scene"]).name for row in catalog.values()}):
        original = scenes / "scenes" / name
        scene = json.loads(original.read_text())
        dependencies = {original}
        for obj in scene["object_instances"]:
            if obj["motion_type"] != "STATIC":
                raise ValueError("HSSD-OV requires static scene placements")
            template = templates.get(obj["template_name"])
            if template is None:
                raise ValueError("missing HSSD object template: " + obj["template_name"])
            obj["template_name"] = str(ROOT / template)
            dependencies.add(assets / template)
        stage = scene["stage_instance"]
        template = (scenes / (stage["template_name"] + ".stage_config.json")).relative_to(assets)
        stage["template_name"] = str(ROOT / template)
        dependencies.add(assets / template)
        out = derived / name
        scene_payloads[out] = scene
        scene_dependencies[name] = dependencies
        files.update(dependencies)
    mesh_dependencies = {}
    for path in sorted(files):
        if path.name.endswith((".stage_config.json", ".object_config.json")):
            config = json.loads(path.read_text())
            mesh_dependencies[path] = {path.parent / config[field] for field in
                                       ("render_asset", "collision_asset", "semantic_asset", "semantic_descriptor_filename")
                                       if config.get(field)}
    original_config = scenes / "hssd-hab.scene_dataset_config.json"
    config = json.loads(original_config.read_text())
    config["scene_instances"]["paths"] = {".json": ["derived_scenes"]}
    output = scenes / "hssd-fe.scene_dataset_config.json"
    shared = {scenes / name for name in config.get("semantic_scene_descriptor_instances", {}).values()}
    shared.update((original_config, output))
    generated = {output: (json.dumps(config, sort_keys=True) + "\n").encode("utf-8")}
    for path, payload in scene_payloads.items():
        generated[path] = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        dependencies = scene_dependencies[path.name]
        dependencies.update(mesh for config in list(dependencies) for mesh in mesh_dependencies.get(config, ()))
        dependencies.add(path)
    files = shared.union(*scene_dependencies.values())
    checksums = {path.relative_to(assets).as_posix(): file_digest(path) for path in sorted(files - generated.keys())}
    checksums.update({path.relative_to(assets).as_posix(): "sha256:" + hashlib.sha256(payload).hexdigest()
                      for path, payload in generated.items()})
    manifest = {
        "source": SCENES_REVISION,
        "shared": sorted(p.relative_to(assets).as_posix() for p in shared),
        "scenes": {name: sorted(p.relative_to(assets).as_posix() for p in dependencies)
                   for name, dependencies in scene_dependencies.items()},
        "files": checksums,
    }
    return manifest, generated


def checked_scene_digest(manifest, release):
    measured = digest(manifest)
    if measured != release["sceneManifestDigest"]:
        raise ValueError("HSSD-OV scene bundle differs from the pinned release")
    return measured


def prepare_scenes(assets, catalog, release):
    manifest, generated = scene_bundle(assets, catalog)
    checked_scene_digest(manifest, release)
    for path, payload in generated.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
    write_json(assets / "orbit-hssd-ov-scenes.json", manifest, compact=True)


def reference(source, assets, catalog, release):
    manifest = json.loads((assets / "orbit-hssd-ov-scenes.json").read_text())
    scene_digest = checked_scene_digest(manifest, release)
    scenes = sorted({Path(row["scene"]).name for row in catalog.values()})
    if sorted(manifest["scenes"]) != scenes:
        raise ValueError("HSSD-OV scene bundle differs from the complete frozen catalog")
    profile = semantic_profile()
    files = release["evaluation"]
    return {
        "id": NAME + "/1", "scoreName": "HSSD-OV native open-vocabulary object navigation", "scoreErrors": "exclude",
        "reference": {"evaluation": SOURCE, "catalogRevision": CATALOG_REVISION, "habitatSim": SIM, "habitatLab": LAB,
                      "files": {"configs/eval_hssdov.yaml": file_digest(source / "configs/eval_hssdov.yaml")}},
        "benchmarkProfile": profile, "observationMap": {"rgb": "rgb", "instruction": "instruction"},
        "parameters": {"replanSteps": 1, "settleSteps": 0, "renderSize": 360, "successRule": "last"},
        "environment": {"kind": NAME, "environmentSeed": 42, "horizon": HORIZON, "controlHz": FPS,
                        "catalog": catalog, "tasks": list(catalog),
                        "taskTitles": {task: goal_instruction(row["category"]) for task, row in catalog.items()},
                        "taskTags": {task: {"category": row["category"], "scene": task.split(":")[0]}
                                     for task, row in catalog.items()},
                        "initialStateCounts": dict.fromkeys(catalog, 1),
                        "initialStateDigests": {task: digest(row) for task, row in catalog.items()},
                        "assets": {"dataset": NAME, "target": str(ROOT), "digest": scene_digest},
                        "evaluationFiles": files},
    }


def export_habitat_sim(source, target):
    """Export the exact native C++ sources without Git history or unused submodules."""
    check_source(source, SIM, {})
    modules = subprocess.check_output(
        ["git", "-C", str(source), "submodule", "status", "--recursive"], text=True).splitlines()
    selected = [line for line in modules if line.split()[1] not in UNUSED_SUBMODULES]
    if not selected or any(line.startswith(("-", "+", "U")) for line in selected):
        raise ValueError("Habitat-Sim requires its pinned C++ submodules")
    export_source(source, SIM, target, ())
    for line in selected:
        commit, name, *_ = line.split()
        origin = source / name
        destination = target / name
        destination.rmdir()
        export_source(origin, {"repository": name, "commit": commit}, destination, ())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--habitat-sim", type=Path)
    parser.add_argument("--habitat-lab", type=Path)
    parser.add_argument("--imath", type=Path)
    parser.add_argument("--base-image", default=BASE)
    parser.add_argument("--assets", type=Path)
    parser.add_argument("--output-dir", type=Path)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--prepare-assets", action="store_true")
    operation.add_argument("--build-tag")
    operation.add_argument("--benchmark-image")
    args = parser.parse_args()
    release = json.loads(RELEASE.read_text())
    if args.prepare_assets:
        if args.assets is None:
            parser.error("--prepare-assets requires --assets")
        prepare_scenes(args.assets, checked_catalog(args.assets, release), release)
        return
    if args.source is None:
        parser.error("--source is required for build or registration")
    check_policy_source(args.source, SOURCE)
    manifest = build_manifest(args.base_image)
    if args.build_tag:
        if args.habitat_sim is None or args.habitat_lab is None or args.imath is None:
            parser.error("--build-tag requires --habitat-sim, --habitat-lab and --imath")
        check_policy_source(args.habitat_lab, LAB)
        with tempfile.TemporaryDirectory(prefix="orbit-hssd-ov-") as directory:
            sim = Path(directory) / "habitat_sim"
            lab = Path(directory) / "habitat_lab"
            imath = Path(directory) / "imath"
            export_habitat_sim(args.habitat_sim, sim)
            export_source(args.habitat_lab, LAB, lab, ("habitat-lab",))
            export_source(args.imath, IMATH, imath, ())
            build_native_image(args.build_tag, "stopwatch", args.source, SOURCE, DOCKERFILE, manifest, SOURCE_PATHS,
                               extra_contexts=(("habitat_sim", sim), ("habitat_lab", lab), ("imath", imath)),
                               build_args=("BENCHMARK_BASE=" + args.base_image,))
        return
    if args.assets is None or args.output_dir is None:
        parser.error("--benchmark-image requires --assets and --output-dir")
    image = require_image(args.benchmark_image, manifest)
    write_benchmark(args.output_dir, NAME, args.source, image, "egl", "python",
                    reference(args.source, args.assets, checked_catalog(args.assets, release), release), gpu_mem=24)


if __name__ == "__main__":
    main()
