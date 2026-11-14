"""Generate independent local registrations for RoboTwin and the published OpenPI recipe."""

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import HERE, check_source, digest, file_digest, implementation_digest
from native_runtime import MANIFEST_LABEL, export_source, image_id, require_image
from orbit_embodied.assets import tree_digest


SEPTEMBER = {"repository": "https://github.com/RoboTwin-Platform/RoboTwin",
             "commit": "ea8b21121ebb3cd201ff5b3fe361944ac94eda3f"}
SEPTEMBER_DOCKERFILE = Path(__file__).with_name("robotwin-september.Dockerfile")
SEPTEMBER_CONFIG = "env_cfg/task_config"


def september_manifest():
    return {"kind": "robotwin-september-2026", "sources": {"robotwin": SEPTEMBER["commit"]},
            "dockerfile": file_digest(SEPTEMBER_DOCKERFILE), "entrypoint": ["/.venv/bin/python"]}


def build_september(source, base, tag):
    with TemporaryDirectory(prefix="orbit-robotwin-september-") as directory:
        context = Path(directory) / "source"
        export_source(source, SEPTEMBER, context, ["envs", SEPTEMBER_CONFIG, "description", "data/decode_image_bit.py"])
        label = MANIFEST_LABEL + "=" + json.dumps(september_manifest(), separators=(",", ":"))
        subprocess.run(["docker", "build", "--label", "orbit.task=embodied-eval", "--label", label,
                        "--build-context", f"robotwin={context}", "--build-arg", f"ROBOTWIN_BASE={base}",
                        "-f", str(SEPTEMBER_DOCKERFILE), "-t", tag, str(HERE.parents[2])], check=True)


def configure_benchmark(args, reference):
    source = reference["reference"]
    environment = reference["environment"]
    suites = json.loads((HERE / "profiles/robotwin-suites.json").read_text()) if args.suite else None
    september = getattr(args, "revision", "original") == "september-2026"
    recipe = getattr(args, "recipe", "joint")
    config_dir = SEPTEMBER_CONFIG if september else "task_config"
    if september:
        if not args.suite or recipe != "joint":
            raise ValueError("the September revision requires a full native joint-control suite")
        check_source(args.robotwin_source, SEPTEMBER, {})
        source["evaluation"] = SEPTEMBER
        source["files"] = {relative: file_digest(args.robotwin_source / relative) for relative in (
            f"{config_dir}/{args.suite}.yml", f"{config_dir}/_camera_config.yml",
            f"{config_dir}/_embodiment_config.yml", f"{config_dir}/_eval_step_limit.yml",
            "envs/_base_task.py", "envs/_GLOBAL_CONFIGS.py", "envs/model_utils.py",
            "description/utils/generate_episode_instructions.py", "scripts/eval_policy_xpolicylab.py",
            "data/decode_image_bit.py",
        )}
        config_text = (args.robotwin_source / config_dir / f"{args.suite}.yml").read_text()
        instruction_split = re.search(r"(?m)^eval_instruction:[ \t]+(seen|unseen)[ \t]*$", config_text)
        if instruction_split is None:
            raise ValueError("expected a native RoboTwin instruction split")
        environment.update(taskConfigDir=config_dir, instructionSeedMode="native-episode-seed",
                           instructionSplit=instruction_split[1],
                           reset="environmentSeed+initialStateId; native expert precheck and instruction RNG")
    elif args.suite == "demo_randomized":
        source["files"]["task_config/demo_randomized.yml"] = suites["randomizedConfig"]
    if args.suite == "demo_randomized":
        source["assets"]["archives"]["background_texture.zip"] = suites["backgroundArchive"]
    check_source(args.robotwin_source, source["evaluation"], source["files"])
    asset_digest = tree_digest(args.assets)
    if args.suite:
        if asset_digest != suites["assetDigests"][args.suite]:
            raise ValueError("RoboTwin suite needs the full assets prepared for " + args.suite)
        # The upstream list contains exactly the benchmark tasks and their native evaluation limits.
        # It is a pinned flat YAML mapping, so registration needs no host YAML dependency.
        limits = (args.robotwin_source / config_dir / "_eval_step_limit.yml").read_text()
        horizons = {}
        for line in limits.splitlines():
            entry = re.fullmatch(r"([a-z][a-z0-9_]*): ([1-9][0-9]*)", line)
            if not entry or entry[1] in horizons:
                raise ValueError("invalid RoboTwin evaluation limit: " + line)
            horizons[entry[1]] = int(entry[2])
        if len(horizons) != 50:
            raise ValueError("expected the 50 official RoboTwin tasks")
        subprocess.run(["git", "-C", str(args.robotwin_source), "diff", "--exit-code", "--quiet", "HEAD",
                        "--", "envs", "description", config_dir], check=True)
        for task in horizons:
            for relative in (f"envs/{task}.py", f"description/task_instruction/{task}.json"):
                source["files"][relative] = file_digest(args.robotwin_source / relative)
        suite_name = args.suite.replace("_", "-")
        reference.update(id=f"robotwin-2.0-{suite_name}/2", scoreUnit="task")
        environment.update(suite=args.suite, tasks=list(horizons), horizons=horizons)
        environment["assets"]["dataset"] = f"robotwin-{suite_name}-full-assets"
    environment["assets"]["digest"] = asset_digest
    suffix = "-full-native" if args.suite else "-native"
    image = require_image(args.benchmark_image, september_manifest()) if september else image_id(args.benchmark_image)
    if september:
        reference["id"] = f"robotwin-2.0-{suite_name}-september-2026/1"
        suffix = "-september-2026-native"
    if recipe == "fast-vla":
        reference["id"] = reference["id"].rsplit("/", 1)[0] + "-fast-vla/1"
        environment["headCameraHistorySteps"] = [17, 8]
        profile = reference["benchmarkProfile"]
        profile["id"] = "robotwin-aloha-agilex-head-history/1"
        for steps in environment["headCameraHistorySteps"]:
            name = f"head_camera_t_minus_{steps}"
            profile["observations"][name] = {**profile["observations"]["head_camera"],
                                              "format": f"RGB-native-t-minus-{steps}"}
            reference["observationMap"][name] = name
        suffix = "-full-fast-vla-native"
    return {
        "name": "robotwin-" + environment["suite"].replace("_", "-") + suffix,
        "adapter": str(HERE / "adapter.py"),
        "path": str(args.robotwin_source.resolve()),
        "config": {"image": image, "reference": json.dumps(reference),
                   "profileDigest": digest(reference), "implementationDigest": implementation_digest(),
                   "simGpus": "1", "simGpuMemGB": "12", "renderer": "vulkan"},
    }


def configure_policy(args, reference):
    model = json.loads((HERE / "profiles/robotwin-openpi.json").read_text())
    check_source(args.openpi_source, model["source"], model["source"]["files"])
    if (model["nativeProfile"] != reference["benchmarkProfile"]["id"]
            or model["replanSteps"] != reference["parameters"]["replanSteps"]):
        raise ValueError("RoboTwin and OpenPI recipes differ")

    checkpoint = model["checkpoint"]
    if (tree_digest(args.weights) != checkpoint["digest"]
            or tree_digest(args.weights / "assets") != checkpoint["normalizationDigest"]):
        raise ValueError("RoboTwin checkpoint differs from the published inference files")

    name = "pi05-robotwin-adjust-bottle"
    service = {
        "name": "policy", "image": image_id(args.policy_image), "cpus": 4, "memGB": 32, "gpuMemGB": 32,
        "env": {"JAX_PLATFORMS": "cuda", "XLA_PYTHON_CLIENT_PREALLOCATE": "false"},
        "command": ["/opt/orbit/serve_openpi.py", "--config", checkpoint["config"], "--checkpoint", "/weights",
                    "--checkpoint-digest", checkpoint["digest"], "--normalization-digest", checkpoint["normalizationDigest"]],
        "healthcheck": {
            "command": ["/.venv/bin/python", "-c",
                        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5).read()"],
            "intervalSec": 10, "timeoutSec": 6, "startPeriodSec": 300, "retries": 90,
        },
    }
    service.update({"gpusOf": "main", "gpus": 0} if args.share_gpu else {"role": "policy", "gpus": 1})
    return {
        "name": name + ("-shared" if args.share_gpu else ""), "version": "1",
        "connector": "openpi-ws", "ioAdapter": "robotwin-native", "replanSteps": model["replanSteps"],
        "profile": {**reference["benchmarkProfile"], "id": model["profileId"]},
        "checkpointDigest": checkpoint["digest"], "normalizationDigest": checkpoint["normalizationDigest"],
        "randomness": model["randomness"], "weights": {"dataset": name, "target": "/weights"},
        "service": service,
    }


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="endpoint", required=True)
    benchmark = commands.add_parser("benchmark")
    benchmark.add_argument("--robotwin-source", type=Path, required=True)
    benchmark.add_argument("--suite", choices=("demo_clean", "demo_randomized"),
                           help="register all tasks for this suite; omit for the legacy adjust_bottle recipe")
    benchmark.add_argument("--recipe", choices=("joint", "fast-vla"), default="joint")
    benchmark.add_argument("--revision", choices=("original", "september-2026"), default="original")
    benchmark.add_argument("--assets", type=Path, required=True)
    benchmark.add_argument("--benchmark-image", required=True)
    benchmark.add_argument("--output-dir", type=Path, required=True)
    build = commands.add_parser("build-september")
    build.add_argument("--robotwin-source", type=Path, required=True)
    build.add_argument("--base-image", required=True)
    build.add_argument("--tag", required=True)
    policy = commands.add_parser("policy")
    policy.add_argument("--openpi-source", type=Path, required=True)
    policy.add_argument("--weights", type=Path, required=True)
    policy.add_argument("--policy-image", required=True)
    policy.add_argument("--share-gpu", action="store_true")
    policy.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    if args.endpoint == "build-september":
        build_september(args.robotwin_source, args.base_image, args.tag)
        return
    if args.endpoint == "benchmark" and args.recipe == "fast-vla" and not args.suite:
        parser.error("the Fast-VLA recipe requires --suite")

    reference = json.loads((HERE / "profiles/robotwin-demo-clean.json").read_text())
    if args.endpoint == "benchmark":
        outputs = {"benchmark.json": configure_benchmark(args, reference), "reference.json": reference}
    else:
        outputs = {"policy.json": configure_policy(args, reference)}
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for filename, value in outputs.items():
        (args.output_dir / filename).write_text(json.dumps(value, indent=2) + "\n")
    print("Wrote the pinned RoboTwin " + args.endpoint + " registration.")


if __name__ == "__main__":
    main()
