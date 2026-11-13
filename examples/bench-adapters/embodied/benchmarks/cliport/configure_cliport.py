"""Build the CLIPort simulator, freeze oracle-accepted test seeds, or register the suite."""

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import SDK, check_source, file_digest
from native_runtime import build_native_image, read_native_catalog, require_image, write_benchmark
from orbit_embodied.assets import tree_digest
from orbit_embodied.cliport import ACTIONS, GOOGLE_ASSETS, TEST_SEED, profile


SOURCE = {"repository": "https://github.com/cliport/cliport",
          "commit": "2be5c47b5bb9bb7040ad90693288b87b1e18e7ad"}
SOURCE_FILES = ("cliport/dataset.py", "cliport/demos.py", "cliport/eval.py", "cliport/cfg/data.yaml",
                "cliport/cfg/eval.yaml", "cliport/environments/environment.py")
DOCKERFILE = Path(__file__).with_name("cliport.Dockerfile")
SEED_PLANNER = Path(__file__).with_name("plan_cliport_seeds.py")
DATASET = "cliport-google-assets"


TORCH_WHEEL = "torch-1.7.1+cpu-cp38-cp38-linux_x86_64.whl"
TORCH_URL = "https://download.pytorch.org/whl/cpu/" + TORCH_WHEEL.replace("+", "%2B")
TORCH_DIGEST = "sha256:fd21e51f6e261e5b44cc7c05a197763f3946dede8ab97dc773126eb1a3b798a1"


def build(args, manifest):
    with tempfile.TemporaryDirectory(prefix="orbit-cliport-wheel-") as directory:
        wheel = Path(directory) / TORCH_WHEEL
        if args.torch_wheel:
            shutil.copyfile(args.torch_wheel, wheel)
        else:
            with urlopen(TORCH_URL, timeout=30) as source, wheel.open("wb") as destination:
                shutil.copyfileobj(source, destination)
        if file_digest(wheel) != TORCH_DIGEST:
            raise ValueError("CLIPort simulator Torch wheel differs from the pinned CPU build")
        build_native_image(args.build_tag, "cliport", args.source, SOURCE, DOCKERFILE, manifest, ("cliport",),
                           extra_contexts=(("torch-wheel", wheel.parent),))


def load_episodes(path, tasks, assets_digest, image):
    record = json.loads(path.read_text())
    if record.get("version") != 2:
        raise ValueError("regenerate the CLIPort seed catalogue to capture per-sample horizons")
    if (record.get("source") != SOURCE["commit"] or record.get("googleAssetsDigest") != assets_digest
            or record.get("simulatorImage") != image):
        raise ValueError("CLIPort seed catalogue belongs to different source, assets or simulator image")
    episodes = record["episodes"]
    if set(episodes) != set(tasks):
        raise ValueError("CLIPort seed catalogue must cover all 18 native test entries")
    counts = {len(entries) for entries in episodes.values()}
    if len(counts) != 1 or not 1 <= next(iter(counts)) <= 100:
        raise ValueError("CLIPort requires the same number of seeds per task, between 1 and 100")
    for entries in episodes.values():
        seeds = []
        for episode in entries:
            seed, horizon = episode["seed"], episode["horizon"]
            if type(seed) is not int or not TEST_SEED <= seed < 2**32 or seed % 2 != 1:
                raise ValueError("CLIPort test seeds must be odd seeds from 10001")
            if type(horizon) is not int or horizon <= 0:
                raise ValueError("CLIPort requires a positive per-sample reset horizon")
            seeds.append(seed)
        if seeds != sorted(set(seeds)):
            raise ValueError("CLIPort test seeds must be unique and ascending")
    return episodes


def plan_seeds(args, image, assets, assets_digest):
    command = ["docker", "run", "--rm", "--network", "none", "--label", "orbit.task=embodied-eval",
               "--mount", f"type=bind,src={SDK},dst=/orbit-sdk,readonly", "-e", "PYTHONPATH=/orbit-sdk",
               "-e", "OMP_NUM_THREADS=1", "-e", "OPENBLAS_NUM_THREADS=1",
               "--mount", f"type=bind,src={assets},dst={GOOGLE_ASSETS},readonly",
               "--mount", f"type=bind,src={SEED_PLANNER.resolve()},dst=/planner.py,readonly",
               image, "-B", "/planner.py", "--episodes", str(args.episodes), "--jobs", str(args.jobs)]
    prefix = "ORBIT_CLIPORT_EPISODES="
    episodes = None
    with subprocess.Popen(command, stdout=subprocess.PIPE, text=True) as planner:
        for line in planner.stdout:
            if line.startswith(prefix):
                episodes = json.loads(line[len(prefix):])
            else:
                print(line.rstrip(), file=sys.stderr, flush=True)
        if planner.wait() or episodes is None:
            raise RuntimeError("CLIPort native seed planner did not finish")
    args.plan_seeds.parent.mkdir(parents=True, exist_ok=True)
    args.plan_seeds.write_text(json.dumps({"version": 2, "source": SOURCE["commit"],
                                         "googleAssetsDigest": assets_digest, "simulatorImage": image,
                                         "episodes": episodes}, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--build-tag")
    mode.add_argument("--benchmark-image")
    parser.add_argument("--torch-wheel", type=Path, help="use a local copy of the pinned CPU wheel for a build")
    parser.add_argument("--google-assets", type=Path)
    output = parser.add_mutually_exclusive_group()
    output.add_argument("--plan-seeds", type=Path)
    output.add_argument("--output-dir", type=Path)
    parser.add_argument("--episodes", type=int, default=100)
    parser.add_argument("--jobs", type=int, default=1)
    parser.add_argument("--seed-catalog", type=Path)
    args = parser.parse_args()
    manifest = {"kind": "cliport", "sources": {"cliport": SOURCE["commit"]},
                "dockerfile": file_digest(DOCKERFILE), "torchWheel": TORCH_DIGEST, "entrypoint": ["python"]}
    if args.build_tag:
        build(args, manifest)
        return
    if not args.google_assets or not (args.plan_seeds or (args.output_dir and args.seed_catalog)):
        parser.error("supply --google-assets and --plan-seeds, or --output-dir and --seed-catalog")
    check_source(args.source, SOURCE, {})
    subprocess.run(["git", "-C", str(args.source), "diff", "--quiet", "HEAD", "--"], check=True)
    image = require_image(args.benchmark_image, manifest)
    assets = args.google_assets.resolve()
    if not (assets / "object-template.urdf").is_file() or not (assets / "meshes_fixed").is_dir():
        raise ValueError("expected the CLIPort v1.0.0 google asset directory")
    assets_digest = tree_digest(assets)
    if args.plan_seeds:
        plan_seeds(args, image, assets, assets_digest)
        return

    catalog = read_native_catalog(image, "orbit_embodied.cliport")
    push_tasks = {task for task, primitive in catalog.items() if primitive == "push"}
    if len(catalog) != 18 or push_tasks != {"separating-piles-seen-colors", "separating-piles-unseen-colors"}:
        raise ValueError("CLIPort native language test suite differs from the pinned catalog")
    episodes = load_episodes(args.seed_catalog, catalog, assets_digest, image)
    for primitive in ACTIONS:
        register(args, image, assets_digest, primitive, {task: episodes[task] for task in catalog
                                                       if catalog[task] == primitive})


def register(args, image, assets_digest, primitive, episodes):
    benchmark_profile = profile("native", primitive)
    name = "cliport-language-test-native" if primitive == "pick-place" else "cliport-language-test-push-native"
    reference = {
        "id": name + "/3",
        "environment": {"kind": "cliport", "tasks": list(episodes), "primitive": primitive,
                        "taskTags": {task: {"primitive": primitive, "endEffector": benchmark_profile["action"]["gripper"]}
                                     for task in episodes},
                        "environmentSeed": TEST_SEED, "testEpisodes": episodes,
                        "initialStateCounts": {task: len(entries) for task, entries in episodes.items()},
                        "assets": {"dataset": DATASET, "target": GOOGLE_ASSETS, "digest": assets_digest}},
        "parameters": {"controlHz": 5, "settleSteps": 0, "renderSize": 480, "replanSteps": 1},
        "reference": {"evaluation": SOURCE, "files": {name: file_digest(args.source / name) for name in SOURCE_FILES},
                      "nativePhysicsHz": 480, "split": "test", "fullEpisodesPerTask": 100},
        "benchmarkProfile": benchmark_profile,
        "observationMap": {key: key for key in benchmark_profile["observations"]},
        "scoreName": "CLIPort cumulative task reward", "scoreUnit": "sample",
    }
    write_benchmark(args.output_dir, name, args.source, image, "pybullet-direct", "/usr/local/bin/python", reference)
    print(f"{name} ({len(episodes)} test entries, {sum(len(entries) for entries in episodes.values())} samples)")


if __name__ == "__main__":
    main()
