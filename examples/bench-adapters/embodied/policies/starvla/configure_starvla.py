"""Freeze StarVLA's four-task WidowX Visual Matching recipe."""

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import HERE, digest, file_digest, implementation_digest
from native_runtime import build_policy_image, check_policy_source, policy_manifest, require_image
from orbit_embodied.assets import tree_digest
from orbit_embodied.simpler import WIDOWX_AREA_SIZE


SOURCE = {"repository": "https://github.com/starVLA/starVLA",
          "commit": "13d8ad43eb4128554c57227507055ecf9c3a62a2"}
EVAL = "examples/simBenchmarks/SimplerEnv/eval_files/"
TASKS = {f"simpler_env_widowx/widowx_{name}" for name in
         ("carrot_on_plate", "put_eggplant_in_basket", "spoon_on_towel", "stack_cube")}
CHECKPOINT = "policy/checkpoints/steps_20000_pytorch_model.pt"
CHECKPOINT_DIGEST = "sha256:769d6c400d582a86ae8df8b0b445240ab679dbe77eeb72a4db71e43cd129c7c3"
STATS = "policy/dataset_statistics.json"
POLICY = Path(__file__).resolve().parent
DOCKERFILE = POLICY / "policy.Dockerfile"


def benchmark_recipe(benchmark, source):
    config = benchmark["config"]
    reference = json.loads(config["reference"])
    environment = reference["environment"]
    if (environment.get("kind") != "registered-gym" or environment.get("simplerRobot") != "widowx"
            or set(environment.get("simplerScenes", {})) != TASKS):
        raise ValueError("expected the four-task WidowX Visual Matching registration")
    profile = reference["benchmarkProfile"]
    native = json.loads((HERE / "profiles/groot-widowx.json").read_text())["benchmarkProfile"]["action"]
    action = {**native, "semantic": "simpler-native-action-and-terminate", "shape": [8],
              "unit": "translation:metre;rotation:radian;terminate:positive",
              "gripper": "native-controller-action", "order": [*native["order"], "terminate"]}
    if profile.get("action") not in (native, action):
        raise ValueError("expected the native WidowX action protocol with or without termination")
    profile["action"] = action
    environment.update(policyTermination=True, widowxAreaResize=True,
                       success="final native done at termination or horizon")
    for task, scenes in environment["simplerScenes"].items():
        environment["horizons"][task] = 120
        for scene in scenes:
            scene["horizon"] = 120

    profile["id"] = "widowx-visual-matching-rgb224/1"
    observations = profile["observations"]
    keys = ("video.image_0", "annotation.human.action.task_description")
    profile["observations"] = {name: observations[name] for name in keys}
    profile["observations"]["video.image_0"].update(
        shape=[WIDOWX_AREA_SIZE, WIDOWX_AREA_SIZE, 3], format="RGB-INTER_AREA-224")
    reference["observationMap"] = {name: name for name in keys}
    reference["policyProfile"] = {**profile, "id": "starvla-widowx-input/1"}
    reference["parameters"].update(renderSize=WIDOWX_AREA_SIZE, replanSteps=1, successRule="last")
    reference["scoreName"] = "SimplerEnv WidowX native final success"
    reference["reference"]["policyRecipe"] = {**SOURCE, "files": {
        name: file_digest(source / name) for name in
        (EVAL + "model2simpler_interface.py", EVAL + "adaptive_ensemble.py",
         EVAL + "auto_eval_scripts/star_bridge.sh")
    }}
    benchmark["name"] = "simpler-widowx-visual-matching-rgb224-native"
    benchmark["adapter"] = str(HERE / "adapter.py")
    reference["id"] = benchmark["name"] + "/1"
    config.update(reference=json.dumps(reference), profileDigest=digest(reference),
                  implementationDigest=implementation_digest())
    return reference


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--build-tag")
    operation.add_argument("--policy-image")
    parser.add_argument("--policy-base")
    parser.add_argument("--benchmark-config", type=Path)
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    if args.build_tag and not args.policy_base:
        parser.error("--build-tag requires --policy-base")
    if args.policy_image and not all((args.benchmark_config, args.weights, args.output_dir)):
        parser.error("--policy-image requires --benchmark-config, --weights and --output-dir")
    check_policy_source(args.source, SOURCE)
    manifest = policy_manifest("starvla-policy", {"starvla": SOURCE}, DOCKERFILE, POLICY / "serve_starvla.py")
    if args.build_tag:
        build_policy_image(args, "starvla", SOURCE, DOCKERFILE, manifest)
        return
    image = require_image(args.policy_image, manifest)
    if file_digest(args.weights / CHECKPOINT) != CHECKPOINT_DIGEST:
        raise ValueError("expected the published QwenGR00T Bridge 20K checkpoint")
    qwen = args.weights / "Qwen3-VL-4B-Instruct"
    index = qwen / "model.safetensors.index.json"
    if not index.is_file() or any(not (qwen / name).is_file()
                                  for name in set(json.loads(index.read_text())["weight_map"].values())):
        raise ValueError("the Qwen3-VL-4B backbone is missing")
    benchmark = json.loads(args.benchmark_config.read_text())
    reference = benchmark_recipe(benchmark, args.source)
    checkpoint, normalization = tree_digest(args.weights), file_digest(args.weights / STATS)
    name = "starvla-qwen3vl-groot-widowx"
    policy = {
        "name": name, "version": "20k", "connector": "policy-ws", "replanSteps": 1, "callTimeoutSec": 300,
        "profile": reference["policyProfile"],
        "checkpointDigest": checkpoint, "normalizationDigest": normalization,
        "randomness": {"backend": "torch", "initialSeed": 0, "scope": "service"},
        "weights": {"dataset": name, "target": "/weights"},
        "service": {
            "name": "policy", "image": image, "gpusOf": "main", "gpus": 0,
            "gpuMemGB": 28, "memGB": 32, "cpus": 4,
            "command": ["--weights", "/weights", "--checkpoint-digest", checkpoint, "--normalization-digest", normalization],
            "healthcheck": {"command": ["python", "-c",
                                        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5).read()"],
                            "intervalSec": 10, "timeoutSec": 6, "startPeriodSec": 300, "retries": 90},
        },
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name, value in (("benchmark", benchmark), ("reference", reference), ("policy", policy)):
        (args.output_dir / (name + ".json")).write_text(json.dumps(value, indent=2) + "\n")


if __name__ == "__main__":
    main()
