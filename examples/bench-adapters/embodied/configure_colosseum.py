"""Build and register the pinned Colosseum V2 ACT benchmark recipes."""

import argparse
import json
from pathlib import Path
from shutil import copyfile
import subprocess
import sys
import tempfile

from adapter import HERE, SDK, check_source, digest, file_digest, implementation_digest, pinned
from native_runtime import MANIFEST_LABEL, export_source, require_image
from orbit_embodied.assets import COLOSSEUM_ASSET_ROOT, tree_digest


SOURCE = {"repository": "https://github.com/jstmn/ColosseumV2",
          "commit": "d16081b3ff6ea4516821f4ad5f66daccaf51c4ed"}
EVALUATOR = "examples/baselines/act_clip/eval_rgbd.py"
NATIVE = "mani_skill/envs/tasks/tabletop/colosseum_v2/"
IDENTITY_FILES = (EVALUATOR, NATIVE + "__init__.py", NATIVE + "colosseum_v2_core.py",
                  NATIVE + "perturbation_set.py", NATIVE + "language_randomizations.yaml")
EXTERNAL = (("external1_camera", 224), ("external2_camera", 224))
SCOPE = {
    "single-arm": {"cameras": EXTERNAL + (("hand_camera", 128),), "state": 25,
                   "action": ("dx", "dy", "dz", "rx", "ry", "rz", "gripper"),
                   "controller": "pd_ee_delta_pose", "frame": "root_translation:root_aligned_body_rotation",
                   "unit": "normalized-controller", "rotation": "delta-euler-xyz"},
    "bimanual": {"cameras": EXTERNAL + (("panda1_hand_camera", 128), ("panda2_hand_camera", 128)), "state": 64,
                 "action": tuple(name for arm in ("panda1", "panda2")
                                 for name in [f"{arm}_joint_{i}" for i in range(1, 8)] + [f"{arm}_gripper"]),
                 "controller": "pd_joint_pos", "frame": "robot-joints",
                 "unit": "radian-and-normalized-gripper", "rotation": "joint-position"},
}


def base_image_id(tag):
    image = subprocess.check_output(["docker", "image", "inspect", "--format", "{{.Id}}", tag], text=True).strip()
    if not pinned(image):
        raise ValueError("Colosseum V2 base requires an immutable local image ID")
    return image


def manifest(base):
    return {"kind": "colosseum-v2", "sources": {"colosseum": SOURCE["commit"]}, "base": base_image_id(base),
            "dockerfile": file_digest(HERE / "colosseum.Dockerfile"), "entrypoint": ["python"]}


def build(source, base, tag, record, wheels):
    with tempfile.TemporaryDirectory(prefix="orbit-colosseum-") as temporary:
        context = Path(temporary) / "source"
        export_source(source, SOURCE, context, ["mani_skill", EVALUATOR])
        local_wheels = context / "wheels"
        local_wheels.mkdir()
        if wheels is not None:
            for wheel in sorted(wheels.glob("*.whl")):
                copyfile(wheel, local_wheels / wheel.name)
        label = MANIFEST_LABEL + "=" + json.dumps(record, sort_keys=True, separators=(",", ":"))
        subprocess.run(["docker", "build", "--label", "orbit.task=colosseum-v2", "--label", label,
                        "--build-context", "colosseum=" + str(context), "--build-arg", "SIMULATOR_BASE=" + base,
                        "-f", str(HERE / "colosseum.Dockerfile"), "-t", tag, str(HERE.parents[2])], check=True)


def native_catalog(image, assets):
    code = ("import json; from orbit_embodied.colosseum import native_catalog; "
            "print('ORBIT_COLOSSEUM=' + json.dumps(native_catalog()))")
    output = subprocess.check_output([
        "docker", "run", "--rm", "--network", "none", "--label", "orbit.task=colosseum-v2",
        "-v", str(assets) + ":" + COLOSSEUM_ASSET_ROOT + ":ro", "-v", str(SDK) + ":/orbit-sdk:ro",
        "-e", "PYTHONPATH=/orbit-sdk", image, "-B", "-c", code,
    ], text=True)
    for line in output.splitlines():
        if line.startswith("ORBIT_COLOSSEUM="):
            return json.loads(line.split("=", 1)[1])
    raise ValueError("missing native Colosseum V2 catalog")


def prepare_assets(image, root, missing):
    for asset in missing:
        subprocess.run(["docker", "run", "--rm", "--label", "orbit.task=colosseum-v2",
                        "-v", str(root) + ":" + COLOSSEUM_ASSET_ROOT, image,
                        "-m", "mani_skill.utils.download_asset", asset, "-y"], check=False)
    # The native downloader can log an error and exit zero.
    return native_catalog(image, root)


def profile_for(morphology):
    scope = SCOPE[morphology]
    observations = {
        camera: {"semantic": "rgb", "camera": camera, "dtype": "uint8", "layout": "HWC", "shape": [size, size, 3]}
        for camera, size in scope["cameras"]
    }
    observations["state"] = {"semantic": "colosseum-v2-act-proprioception", "dtype": "float32", "shape": [scope["state"]]}
    observations["instruction"] = {"semantic": "language-instruction", "dtype": "string", "shape": []}
    action = {"semantic": "colosseum-v2-" + morphology + "-control", "shape": [len(scope["action"])],
              "controller": scope["controller"], "frame": scope["frame"], "unit": scope["unit"],
              "rotation": scope["rotation"], "gripper": "normalized-panda-position[-0.01m,0.04m]", "order": list(scope["action"])}
    return {"id": "colosseum-v2-" + morphology + "/1", "observations": observations, "action": action}


def reference_for(catalog, morphology, preset, asset_digest, files):
    name = f"colosseum-v2-{morphology}-{preset.lower().replace('_', '-')}-native"
    task_ids = catalog["morphologies"][morphology]
    missing = set(catalog["missingAssets"])
    unsupported = {}
    for task in task_ids:
        task_meta = catalog["tasks"][task]
        if preset in task_meta["disabled"]:
            unsupported[task] = "Perturbation disabled by the native evaluator"
            continue
        needed = set(task_meta["assets"])
        if preset in ("DISTRACTOR_OBJECT", "ALL"):
            needed.update(catalog["distractorAssets"])
        missing_task_assets = sorted(needed & missing)
        if missing_task_assets:
            unsupported[task] = "Missing native assets: " + ", ".join(missing_task_assets)
    profile = profile_for(morphology)
    environment = {
        "kind": "colosseum-v2", "morphology": morphology, "perturbation": preset, "tasks": task_ids,
        "horizons": {task: catalog["tasks"][task]["horizon"] for task in task_ids},
        "instructions": {task: catalog["tasks"][task]["instruction"] for task in task_ids},
        "unsupported": unsupported,
        "assets": {"dataset": "colosseum-v2-assets", "target": COLOSSEUM_ASSET_ROOT, "digest": asset_digest},
    }
    return name, {"id": name + "/1", "environment": environment, "benchmarkProfile": profile,
                  "observationMap": {name: name for name in profile["observations"]},
                  "parameters": {"replanSteps": 1, "settleSteps": 0, "controlHz": 20, "successRule": "any"},
                  "reference": {"evaluation": SOURCE, "files": files},
                  "scoreName": "Colosseum V2 success once", "scoreUnit": "sample"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--simulator-base", required=True)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--build-tag")
    operation.add_argument("--benchmark-image")
    parser.add_argument("--dependency-wheels", type=Path)
    parser.add_argument("--assets", type=Path)
    parser.add_argument("--prepare-assets", action="store_true")
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    check_source(args.source, SOURCE, {})
    record = manifest(args.simulator_base)
    if args.build_tag:
        build(args.source, args.simulator_base, args.build_tag, record, args.dependency_wheels)
        return
    if args.assets is None or (args.output_dir is None and not args.prepare_assets):
        parser.error("registration requires --assets and --output-dir, or use --prepare-assets")
    image = require_image(args.benchmark_image, record)
    args.assets = args.assets.resolve()
    args.assets.mkdir(parents=True, exist_ok=True)
    catalog = native_catalog(image, args.assets)
    if args.prepare_assets and catalog["missingAssets"]:
        catalog = prepare_assets(image, args.assets, catalog["missingAssets"])
        failures = catalog["missingAssets"]
        if failures:
            message = "Could not prepare native assets: " + ", ".join(failures)
            if args.output_dir is None:
                raise SystemExit(message)
            print(message, file=sys.stderr)
    if args.output_dir is None:
        return
    subprocess.run(["git", "-C", str(args.source), "diff", "--quiet", "HEAD", "--", *IDENTITY_FILES], check=True)
    files = {relative: file_digest(args.source / relative) for relative in IDENTITY_FILES}
    assets = tree_digest(args.assets)
    implementation = implementation_digest()
    for morphology in SCOPE:
        for preset in catalog["presets"]:
            name, reference = reference_for(catalog, morphology, preset, assets, files)
            config = {"image": image, "python": "python", "renderer": "vulkan",
                      "simGpus": "1", "simGpuMemGB": "8", "reference": json.dumps(reference),
                      "profileDigest": digest(reference), "implementationDigest": implementation}
            benchmark = {"name": name, "path": str(args.source.resolve()), "adapter": str(HERE / "adapter.py"),
                         "config": config}
            output = args.output_dir / name
            output.mkdir(parents=True, exist_ok=True)
            for filename, value in (("benchmark.json", benchmark), ("reference.json", reference)):
                (output / filename).write_text(json.dumps(value, indent=2) + "\n")
            unsupported = reference["environment"]["unsupported"]
            print(name, len(reference["environment"]["tasks"]) - len(unsupported), "supported tasks")


if __name__ == "__main__":
    main()
