"""Generate local registrations for RoboCasa365 and a published policy."""

import argparse
import ast
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import HERE, check_source, digest, file_digest, implementation_digest
from native_runtime import image_id
from orbit_embodied.assets import tree_digest
from orbit_embodied.binding import robocasa_horizon


RECIPES = {"openpi": "robocasa365-openpi", "gr00t": "robocasa365-gr00t-n15",
           "diffusion-policy": "robocasa365-diffusion-policy"}
TASK_SETS = {
    "atomic_seen": "Atomic-Seen",
    "composite_seen": "Composite-Seen",
    "composite_unseen": "Composite-Unseen",
    "target50": "Target 50",
    "all_tasks": "All Tasks",
    "all_atomic_tasks": "All Atomic Tasks",
    "all_composite_tasks": "All Composite Tasks",
    **{f"lifelong_learning_phase{n}": f"Lifelong Phase {n}" for n in range(1, 5)},
    **{f"lifelong_through_phase{n}": f"Lifelong Through Phase {n}" for n in range(2, 5)},
}


def scope_tasks(definitions, task_set):
    atomic = {item.arg: item.value for item in definitions["ATOMIC_TASK_DATASETS"].keywords}
    composite = {item.arg: item.value for item in definitions["COMPOSITE_TASK_DATASETS"].keywords}
    datasets = {**atomic, **composite}
    catalogs = {"all_tasks": datasets, "all_atomic_tasks": atomic, "all_composite_tasks": composite}
    if task_set in catalogs:
        return list(catalogs[task_set]), datasets
    if task_set.startswith("lifelong_"):
        number = int(task_set[-1])
        phases = {1: list(atomic)}
        for item in definitions["LIFELONG_LEARNING_TASKS"].keywords:
            if item.arg != "lifelong_learning_phase1":
                phases[int(item.arg[-1])] = ast.literal_eval(item.value)
        selected = range(1, number + 1) if task_set.startswith("lifelong_through") else (number,)
        return [task for phase in selected for task in phases[phase]], datasets
    targets = {item.arg: ast.literal_eval(item.value) for item in definitions["TARGET_TASKS"].keywords}
    selected = ("atomic_seen", "composite_seen", "composite_unseen") if task_set == "target50" else (task_set,)
    return [task for group in selected for task in targets[group]], datasets


def set_benchmark_scope(reference, root, task_set, split, recipe):
    """Read the pinned registry without importing simulator dependencies on the host."""
    registry = ast.parse((root / "robocasa/utils/dataset_registry.py").read_text())
    definitions = {node.targets[0].id: node.value for node in registry.body
                   if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)}
    names, datasets = scope_tasks(definitions, task_set)
    environment = reference["environment"]
    horizons = {}
    for name in names:
        horizon = next(ast.literal_eval(item.value) for item in datasets[name].keywords if item.arg == "horizon")
        horizons["robocasa/" + name] = robocasa_horizon(horizon, environment)
    if len(horizons) != len(names):
        raise ValueError("duplicate task in the pinned RoboCasa365 task set")
    environment.update(split=split, tasks=list(horizons), horizons=horizons)
    name = "robocasa365-" + task_set.replace("_", "-")
    if recipe != "openpi":
        name += "-" + recipe
    if split == "target":
        name += "-target"
    reference["id"] = name + "/1"
    reference["scoreName"] = "RoboCasa365 " + TASK_SETS[task_set] + " success"
    if split == "target":
        reference["scoreName"] += " (target scenes)"
    return name + "-native"


def groot_reference(reference, model):
    reference["scoreErrors"] = "exclude"
    source = reference["reference"]
    source["robocasa"]["commit"] = model["benchmark"]["robocasaCommit"]
    source["files"].update(model["benchmark"]["files"])
    source["evaluation"] = model["source"]
    reference["environment"]["horizonScale"] = 1
    reference["parameters"].pop("resizeSize")
    reference["parameters"].update(replanSteps=16, successRule="chunk-last-any")


def diffusion_reference(reference, model):
    reference["scoreErrors"] = "exclude"
    reference["reference"]["evaluation"] = model["source"]
    reference["environment"]["protocol"] = "diffusion-policy"
    parameters = reference["parameters"]
    parameters.pop("resizeSize")
    parameters.update(replanSteps=8, successRule="any", environmentSeed=1111111)
    profile = reference["benchmarkProfile"]
    profile["id"] = "robocasa365-panda-omron-history2/1"
    for name in ("state.base_position", "state.base_rotation"):
        del profile["observations"][name]
        del reference["observationMap"][name]
    for field in profile["observations"].values():
        if field["dtype"] != "string":
            field["shape"] = [2, *field["shape"]]
            if field["semantic"] == "rgb":
                field["layout"] = "THWC"


def diffusion_policy(args, reference, model):
    for key in ("source", "robomimic"):
        source = model[key]
        check_source(args.diffusion_source if key == "source" else args.robomimic_source, source, source["files"])
    checkpoint = file_digest(args.weights / model["checkpointFile"])
    backbone = tree_digest(args.weights / "clip")
    if checkpoint != model["checkpointDigest"] or backbone != model["backboneDigest"]:
        raise ValueError("inference assets differ from the published Diffusion Policy recipe")
    normalization = model["normalizationDigest"]
    name = "diffusion-policy-robocasa365"
    server = "/opt/orbit/serve_diffusion_policy.py"
    service = {
        "name": "policy", "image": image_id(args.policy_image), "cpus": 4, "memGB": 12, "gpuMemGB": 8,
        "command": [server, "--weights", "/weights", "--checkpoint-digest", checkpoint,
                    "--normalization-digest", normalization, "--backbone-digest", backbone],
        "healthcheck": {"command": ["/.venv/bin/python", server, "--healthcheck"],
                        "intervalSec": 5, "timeoutSec": 5, "startPeriodSec": 120, "retries": 24},
    }
    service.update({"gpusOf": "main", "gpus": 0} if args.share_gpu else {"role": "policy", "gpus": 1})
    return {
        "name": name + ("-shared" if args.share_gpu else ""),
        "version": "1", "connector": "policy-ws", "replanSteps": reference["parameters"]["replanSteps"],
        "randomness": model["randomness"], "profile": {**reference["benchmarkProfile"], "id": name + "/1"},
        "checkpointDigest": checkpoint, "normalizationDigest": normalization, "backboneDigest": backbone,
        "weights": {"dataset": name, "target": "/weights"}, "service": service,
    }


def configure_policy(args, reference, model, groot):
    policy_root = args.groot_source or args.openpi_source
    evaluation = reference["reference"]["evaluation"]
    check_source(policy_root, evaluation, evaluation["files"])
    if not groot:
        check_source(policy_root, model["source"], model["source"]["files"])
    if (model["nativeProfile"] != reference["benchmarkProfile"]["id"]
            or model["replanSteps"] != reference["parameters"]["replanSteps"]):
        raise ValueError("RoboCasa365 benchmark and policy recipes differ")

    weights = args.weights
    required = (["config.json", "model.safetensors.index.json", "experiment_cfg/metadata.json"] if groot
                else ["_CHECKPOINT_METADATA", "params/manifest.ocdbt", "assets/norm_stats.json"])
    if any(not (weights / filename).is_file() for filename in required):
        raise ValueError("RoboCasa365 inference checkpoint is incomplete")
    checkpoint = tree_digest(weights)
    normalization = (file_digest(weights / "experiment_cfg/metadata.json") if groot
                     else tree_digest(weights / "assets"))
    if checkpoint != model["checkpoint"]["digest"] or normalization != model["checkpoint"]["normalizationDigest"]:
        raise ValueError("checkpoint contents differ from the published RoboCasa365 inference files")
    service = {
        "name": "policy", "image": image_id(args.policy_image), "cpus": 4, "memGB": 32, "gpuMemGB": 24,
        "healthcheck": {"intervalSec": 10, "timeoutSec": 6, "startPeriodSec": 300, "retries": 90},
    }
    assets_args = ["--checkpoint", "/weights", "--checkpoint-digest", checkpoint,
                   "--normalization-digest", normalization]
    extra = {}
    if groot:
        backbone = tree_digest(policy_root / model["backbone"]["path"])
        if backbone != model["backbone"]["digest"]:
            raise ValueError("bundled Eagle assets differ from the published recipe")
        server = "/opt/orbit/serve_groot_n15.py"
        service["env"] = {"NO_ALBUMENTATIONS_UPDATE": "1"}
        service["command"] = [server, *assets_args, "--backbone-digest", backbone]
        service["healthcheck"]["command"] = ["/.venv/bin/python", server, "--healthcheck"]
        extra = {"backboneDigest": backbone, "port": 5555}
    else:
        service["env"] = {"JAX_PLATFORMS": "cuda", "XLA_PYTHON_CLIENT_PREALLOCATE": "false"}
        service["command"] = ["/opt/orbit/serve_openpi.py", "--robocasa-inference", "--config",
                              model["checkpoint"]["config"], *assets_args]
        service["healthcheck"]["command"] = ["/.venv/bin/python", "-c",
            "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5).read()"]
    service.update({"gpusOf": "main", "gpus": 0} if args.share_gpu else {"role": "policy", "gpus": 1})
    policy_name = "groot-n15-robocasa365" if groot else "pi05-robocasa365"
    return {
        "name": policy_name + ("-shared" if args.share_gpu else ""),
        "version": "1", "connector": "groot-zmq" if groot else "openpi-ws", "ioAdapter": "robocasa-native",
        "callTimeoutSec": 300, "replanSteps": model["replanSteps"], "randomness": model["randomness"],
        "profile": {**reference["benchmarkProfile"], "id": model["profileId"]},
        "checkpointDigest": checkpoint, "normalizationDigest": normalization,
        "weights": {"dataset": policy_name, "target": "/weights"}, "service": service, **extra,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--robocasa-source", type=Path, required=True)
    parser.add_argument("--robosuite-source", type=Path, required=True)
    parser.add_argument("--task-set", choices=TASK_SETS, default="atomic_seen")
    parser.add_argument("--split", choices=("pretrain", "target"), default="pretrain")
    parser.add_argument("--recipe", choices=RECIPES, help="Defaults to OpenPI or follows the supplied policy source.")
    parser.add_argument("--benchmark-only", action="store_true")
    policy_source = parser.add_mutually_exclusive_group()
    policy_source.add_argument("--openpi-source", type=Path)
    policy_source.add_argument("--groot-source", type=Path)
    policy_source.add_argument("--diffusion-source", type=Path)
    parser.add_argument("--robomimic-source", type=Path)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--policy-image")
    parser.add_argument("--benchmark-image", required=True)
    parser.add_argument("--share-gpu", action="store_true")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    policy_root = args.groot_source or args.diffusion_source or args.openpi_source
    if args.benchmark_only:
        if policy_root or args.robomimic_source or args.weights or args.policy_image or args.share_gpu:
            parser.error("policy arguments cannot be used with --benchmark-only")
    elif not (policy_root and args.weights and args.policy_image):
        parser.error("a policy source, --weights and --policy-image are required unless using --benchmark-only")
    if bool(args.diffusion_source) != bool(args.robomimic_source):
        parser.error("--diffusion-source and --robomimic-source must be provided together")
    inferred = "gr00t" if args.groot_source else "diffusion-policy" if args.diffusion_source else "openpi"
    if policy_root and args.recipe not in (None, inferred):
        parser.error("--recipe does not match the policy source")
    recipe = args.recipe or inferred

    reference = json.loads((HERE / "profiles/robocasa365-atomic-seen.json").read_text())
    model = json.loads((HERE / "profiles" / (RECIPES[recipe] + ".json")).read_text())
    if recipe == "gr00t":
        groot_reference(reference, model)
    elif recipe == "diffusion-policy":
        diffusion_reference(reference, model)
    source = reference["reference"]
    check_source(args.robocasa_source, source["robocasa"], source["files"])
    check_source(args.robosuite_source, source["robosuite"], source["robosuite"]["files"])
    name = set_benchmark_scope(reference, args.robocasa_source, args.task_set, args.split, recipe)
    reference["environment"]["assets"]["digest"] = tree_digest(args.assets)
    benchmark = {
        "name": name,
        "adapter": str(HERE / "adapter.py"),
        "path": str(args.robocasa_source.resolve()),
        "config": {"image": image_id(args.benchmark_image), "python": "/usr/local/bin/python",
                   "reference": json.dumps(reference), "profileDigest": digest(reference),
                   "implementationDigest": implementation_digest(),
                   "simGpus": "1", "renderer": "egl", "simGpuMemGB": "4"},
    }
    outputs = {"benchmark.json": benchmark, "reference.json": reference}
    if not args.benchmark_only:
        outputs["policy.json"] = (diffusion_policy(args, reference, model) if recipe == "diffusion-policy"
                                  else configure_policy(args, reference, model, recipe == "gr00t"))
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for filename, value in outputs.items():
        (args.output_dir / filename).write_text(json.dumps(value, indent=2) + "\n")
    print("Wrote the pinned RoboCasa365 registration files and sample-plan reference.")


if __name__ == "__main__":
    main()
