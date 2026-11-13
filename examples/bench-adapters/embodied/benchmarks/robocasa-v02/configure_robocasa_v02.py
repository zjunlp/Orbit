"""Register the original RoboCasa atomic protocol independently of policy weights."""

import argparse
import ast
import json
from pathlib import Path
import subprocess
from xml.etree import ElementTree
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import HERE, check_source, digest, file_digest, implementation_digest
from native_runtime import ROBOCASA, ROBOSUITE, require_image, robocasa_sources, runtime_manifest
from orbit_embodied.assets import tree_digest


REGISTRY = "robocasa/utils/dataset_registry.py"
CAMERAS = ("robot0_agentview_left", "robot0_eye_in_hand")
LAYOUTS = ((1, 1), (2, 2), (4, 4), (6, 9), (7, 10))


def atomic_horizons(registry):
    source = ast.parse(registry.read_text())
    assignment = next(node for node in source.body if isinstance(node, ast.Assign)
                      and any(isinstance(target, ast.Name) and target.id == "SINGLE_STAGE_TASK_DATASETS"
                              for target in node.targets))
    horizons = {
        row.arg: ast.literal_eval(next(field.value for field in row.value.keywords if field.arg == "horizon"))
        for row in assignment.value.keywords if row.arg != "NavigateKitchen"
    }
    if len(horizons) != 24 or any(type(value) is not int or value <= 0 for value in horizons.values()):
        raise ValueError("expected the pinned 24-task RoboCasa atomic registry")
    return horizons


SOURCE_FILES = (REGISTRY, "robocasa/utils/env_utils.py", "robocasa/environments/kitchen/kitchen.py")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--robosuite-source", type=Path, required=True)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--benchmark-image", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    image = require_image(args.benchmark_image, runtime_manifest("robocasa-v02", robocasa_sources()))
    root = args.source.resolve()
    files = {name: file_digest(root / name) for name in SOURCE_FILES}
    check_source(root, ROBOCASA, files)
    check_source(args.robosuite_source, ROBOSUITE, {})
    for source in (root, args.robosuite_source):
        subprocess.run(["git", "-C", str(source), "diff", "--quiet", "HEAD", "--"], check=True)
    if any(not (args.assets / path).is_dir() for path in ("arenas", "fixtures", "objects/objaverse", "textures")):
        parser.error("--assets must contain the assembled original RoboCasa assets")
    models = sorted((args.assets / "objects/objaverse").rglob("model.xml"))
    sites = {"bottom_site", "top_site", "horizontal_radius_site"}
    if not models or any(not sites.issubset({site.get("name") for site in ElementTree.parse(model).iter("site")})
                         for model in models):
        parser.error("--assets requires the v0.2 object XMLs with placement sites")
    assets = {"dataset": "robocasa-v02-assets", "target": "/opt/robocasa-v02-assets",
              "digest": tree_digest(args.assets)}
    horizons = atomic_horizons(root / REGISTRY)
    fields = {camera: {"semantic": "rgb", "camera": camera, "dtype": "uint8", "layout": "HWC",
                       "shape": [128, 128, 3]} for camera in CAMERAS}
    fields["instruction"] = {"semantic": "language-instruction", "dtype": "string", "shape": []}
    action = {"semantic": "robocasa-v02-panda-delta-arm-and-gripper", "shape": [7],
              "controller": "pandaomron-osc-pose", "frame": "robot-base", "unit": "controller-normalized",
              "rotation": "delta-axis-angle", "gripper": "signed-close-open",
              "order": ["dx", "dy", "dz", "drx", "dry", "drz", "gripper"]}
    profile = {"id": "robocasa-v02-panda-arm/1", "observations": fields, "action": action}
    name = "robocasa-v02-atomic-native"
    reference = {
        "id": name + "/1",
        "environment": {"kind": "robocasa-v02", "assets": assets, "tasks": list(horizons), "horizons": horizons,
                        "initialStateCount": 50, "cameras": CAMERAS, "objectSplit": "B", "layoutStylePairs": LAYOUTS},
        "parameters": {"controlHz": 20, "renderSize": 128, "settleSteps": 0, "replanSteps": 1},
        "reference": {"evaluation": ROBOCASA, "robosuite": ROBOSUITE, "files": files},
        "benchmarkProfile": profile,
        "observationMap": {key: key for key in fields},
        "scoreName": "RoboCasa v0.2 atomic success", "scoreUnit": "task",
    }
    benchmark = {"name": name, "path": str(root), "adapter": str(HERE / "adapter.py"), "config": {
        "image": image, "python": "/usr/local/bin/python", "renderer": "osmesa",
        "reference": json.dumps(reference, separators=(",", ":")), "profileDigest": digest(reference),
        "implementationDigest": implementation_digest(),
    }}
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for filename, value in (("benchmark.json", benchmark), ("reference.json", reference)):
        (args.output_dir / filename).write_text(json.dumps(value, indent=2) + "\n")


if __name__ == "__main__":
    main()
