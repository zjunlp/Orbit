"""Generate independent local registrations for RoboTwin and the published OpenPI recipe."""

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import HERE, check_source, digest, file_digest, implementation_digest
from native_runtime import build_native_image, image_id, require_image
from orbit_embodied.assets import checkpoint_tree_digest, tree_digest


DOCKERFILE = Path(__file__).with_name("robotwin.Dockerfile")
CONFIG_DIR = "env_cfg/task_config"
RUNTIME_PATHS = ("envs", CONFIG_DIR, "description", "data/decode_image_bit.py")
SUITES = ("demo_clean", "demo_randomized")
CHUNK_RECIPES = {"absolute-ee": 1, "qpos-chunk-8": 8, "qpos-chunk-16": 16}
POLICY_RECIPES = ("fast-vla", *CHUNK_RECIPES)
POSE_ORDER = [f"{arm}_{part}" for arm in ("left", "right")
              for part in ("x", "y", "z", "qw", "qx", "qy", "qz", "gripper")]


def simulator_manifest(reference):
    return {"kind": "robotwin-2.0", "sources": {"robotwin": reference["reference"]["evaluation"]["commit"]},
            "dockerfile": file_digest(DOCKERFILE), "entrypoint": ["/.venv/bin/python"]}


def build_simulator(args, reference):
    contexts = []
    build_args = []
    if args.base_image:
        build_args.append("ROBOTWIN_DEPENDENCIES=" + args.base_image)
    else:
        model = json.loads((HERE / "profiles/robotwin-openpi.json").read_text())
        check_source(args.curobo_source, reference["reference"]["curobo"], {})
        check_source(args.openpi_source, model["source"], model["source"]["files"])
        contexts.extend((("curobo", args.curobo_source.resolve()), ("openpi", args.openpi_source.resolve())))
        build_args.extend(("CUDA_ARCH=" + args.cuda_arch, "POLICY_BASE=" + args.policy_base))
        if args.cuda_toolkit:
            contexts.append(("cuda-toolkit", args.cuda_toolkit.resolve()))
            build_args.append("CUDA_TOOLKIT_SOURCE=/")
        if args.torch_wheels:
            contexts.append(("torch-wheels", args.torch_wheels.resolve()))
    build_native_image(args.tag, "robotwin", args.robotwin_source, reference["reference"]["evaluation"],
                       DOCKERFILE, simulator_manifest(reference), RUNTIME_PATHS,
                       extra_contexts=contexts, build_args=build_args)


def configure_benchmark(args, reference):
    source = reference["reference"]
    environment = reference["environment"]
    suites = json.loads((HERE / "profiles/robotwin-suites.json").read_text())
    recipe = getattr(args, "recipe", "joint")
    check_source(args.robotwin_source, source["evaluation"], source["files"])
    subprocess.run(["git", "-C", str(args.robotwin_source), "diff", "--exit-code", "--quiet", "HEAD",
                    "--", *RUNTIME_PATHS], check=True)
    config_text = (args.robotwin_source / CONFIG_DIR / f"{args.suite}.yml").read_text()
    instruction_split = re.search(r"(?m)^eval_instruction:[ \t]+(seen|unseen)[ \t]*$", config_text)
    if instruction_split is None:
        raise ValueError("expected a native RoboTwin instruction split")
    if args.suite == "demo_randomized":
        source["assets"]["archives"]["background_texture.zip"] = suites["backgroundArchive"]
    image = require_image(args.benchmark_image, simulator_manifest(reference))
    asset_digest = tree_digest(args.assets)
    if asset_digest != suites["assetDigests"][args.suite]:
        raise ValueError("RoboTwin suite needs the full assets prepared for " + args.suite)
    # The pinned flat YAML mapping supplies the official catalog and control limits.
    limits = (args.robotwin_source / CONFIG_DIR / "_eval_step_limit.yml").read_text()
    horizons = {}
    for line in limits.splitlines():
        entry = re.fullmatch(r"([a-z][a-z0-9_]*): ([1-9][0-9]*)", line)
        if not entry or entry[1] in horizons:
            raise ValueError("invalid RoboTwin evaluation limit: " + line)
        horizons[entry[1]] = int(entry[2])
    if len(horizons) != 50:
        raise ValueError("expected the 50 official RoboTwin tasks")
    for task in horizons:
        for relative in (f"envs/{task}.py", f"description/task_instruction/{task}.json"):
            source["files"][relative] = file_digest(args.robotwin_source / relative)
    suite_name = args.suite.replace("_", "-")
    reference["id"] = f"robotwin-2.0-{suite_name}/3"
    environment.update(suite=args.suite, tasks=list(horizons), horizons=horizons, instructionSplit=instruction_split[1])
    environment["assets"].update(dataset=f"robotwin-{suite_name}-full-assets", digest=asset_digest)
    suffix = "-full-native"
    if recipe == "fast-vla":
        reference["id"] = reference["id"].rsplit("/", 1)[0] + "-fast-vla/2"
        environment["headCameraHistorySteps"] = [17, 8]
        profile = reference["benchmarkProfile"]
        profile["id"] = "robotwin-aloha-agilex-head-history/1"
        for steps in environment["headCameraHistorySteps"]:
            name = f"head_camera_t_minus_{steps}"
            profile["observations"][name] = {**profile["observations"]["head_camera"],
                                              "format": f"RGB-native-t-minus-{steps}"}
            reference["observationMap"][name] = name
        suffix = "-full-fast-vla-native"
    elif recipe in CHUNK_RECIPES:
        reference["id"] = reference["id"].rsplit("/", 1)[0] + f"-{recipe}/2"
        reference["parameters"]["replanSteps"] = CHUNK_RECIPES[recipe]
        if recipe == "qpos-chunk-8":
            reference["parameters"].pop("resizeSize", None)
        environment["controller"] = recipe
        suffix = f"-full-{recipe}-native"
        if recipe == "absolute-ee":
            profile = reference["benchmarkProfile"]
            profile["id"] = "robotwin-aloha-agilex-absolute-ee/1"
            coordinates = {"shape": [16], "frame": "robotwin-world", "unit": "meters-and-normalized-gripper",
                           "order": POSE_ORDER}
            profile["observations"].pop("joint_state")
            profile["observations"]["ee_pose"] = {
                **coordinates, "semantic": "aloha-agilex-live-end-effector-pose", "dtype": "float64",
            }
            profile["action"] = {
                **coordinates, "semantic": "absolute-end-effector-and-gripper-target", "controller": "robotwin-ee",
                "rotation": "quaternion-wxyz", "gripper": "normalized-open-fraction",
            }
            reference["observationMap"].pop("joint_state")
            reference["observationMap"]["ee_pose"] = "ee_pose"
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
    if (checkpoint_tree_digest(args.weights) != checkpoint["digest"]
            or checkpoint_tree_digest(args.weights / "assets") != checkpoint["normalizationDigest"]):
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
    benchmark.add_argument("--suite", choices=SUITES, default="demo_clean")
    benchmark.add_argument("--recipe", choices=("joint", *POLICY_RECIPES), default="joint")
    benchmark.add_argument("--assets", type=Path, required=True)
    benchmark.add_argument("--benchmark-image", required=True)
    benchmark.add_argument("--output-dir", type=Path, required=True)
    build = commands.add_parser("build-simulator")
    build.add_argument("--robotwin-source", type=Path, required=True)
    build.add_argument("--base-image", help="Reuse an existing RoboTwin simulator dependency image")
    build.add_argument("--curobo-source", type=Path)
    build.add_argument("--openpi-source", type=Path)
    build.add_argument("--policy-base", default="orbit/openpi-policy:reference")
    build.add_argument("--cuda-arch", default="8.0")
    build.add_argument("--cuda-toolkit", type=Path)
    build.add_argument("--torch-wheels", type=Path)
    build.add_argument("--tag", required=True)
    policy = commands.add_parser("policy")
    policy.add_argument("--openpi-source", type=Path, required=True)
    policy.add_argument("--weights", type=Path, required=True)
    policy.add_argument("--policy-image", required=True)
    policy.add_argument("--share-gpu", action="store_true")
    policy.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    reference = json.loads((HERE / "profiles/robotwin-demo-clean.json").read_text())
    if args.endpoint == "build-simulator":
        if not args.base_image and not (args.curobo_source and args.openpi_source):
            parser.error("build-simulator requires --curobo-source and --openpi-source or --base-image")
        build_simulator(args, reference)
        return
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
