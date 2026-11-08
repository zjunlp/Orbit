"""Generate local registrations for RoboCasa365 and a published policy."""

import argparse
import json
from pathlib import Path

from adapter import HERE, check_source, digest, file_digest, implementation_digest
from configure_groot import image_id
from orbit_embodied.assets import tree_digest


def groot_reference(reference, model):
    reference["id"] = "robocasa365-atomic-seen-gr00t/1"
    reference["scoreErrors"] = "exclude"
    source = reference["reference"]
    source["robocasa"]["commit"] = model["benchmark"]["robocasaCommit"]
    source["files"].update(model["benchmark"]["files"])
    source["evaluation"] = model["source"]
    reference["environment"]["horizonScale"] = 1
    reference["parameters"].pop("resizeSize")
    reference["parameters"].update(replanSteps=16, successRule="chunk-last-any")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--robocasa-source", type=Path, required=True)
    parser.add_argument("--robosuite-source", type=Path, required=True)
    policy_source = parser.add_mutually_exclusive_group(required=True)
    policy_source.add_argument("--openpi-source", type=Path)
    policy_source.add_argument("--groot-source", type=Path)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--policy-image", required=True)
    parser.add_argument("--benchmark-image", required=True)
    parser.add_argument("--share-gpu", action="store_true")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    reference = json.loads((HERE / "profiles/robocasa365-atomic-seen.json").read_text())
    groot = args.groot_source is not None
    model_path = "profiles/robocasa365-gr00t-n15.json" if groot else "profiles/robocasa365-openpi.json"
    model = json.loads((HERE / model_path).read_text())
    if groot:
        groot_reference(reference, model)
    policy_root = args.groot_source or args.openpi_source
    source = reference["reference"]
    check_source(args.robocasa_source, source["robocasa"], source["files"])
    for root, component in ((args.robosuite_source, "robosuite"), (policy_root, "evaluation")):
        check_source(root, source[component], source[component]["files"])
    if not groot:
        check_source(policy_root, model["source"], model["source"]["files"])
    if (model["nativeProfile"] != reference["benchmarkProfile"]["id"]
            or model["replanSteps"] != reference["parameters"]["replanSteps"]):
        raise ValueError("RoboCasa365 benchmark and policy recipes differ")

    assets = reference["environment"]["assets"]
    assets["digest"] = tree_digest(args.assets)
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
    policy = {
        "name": policy_name + ("-shared" if args.share_gpu else ""),
        "version": "1", "connector": "groot-zmq" if groot else "openpi-ws", "ioAdapter": "robocasa-native",
        "callTimeoutSec": 300, "replanSteps": model["replanSteps"], "randomness": model["randomness"],
        "profile": {**reference["benchmarkProfile"], "id": model["profileId"]},
        "checkpointDigest": checkpoint, "normalizationDigest": normalization,
        "weights": {"dataset": policy_name, "target": "/weights"}, "service": service, **extra,
    }
    benchmark = {
        "name": "robocasa365-atomic-seen-gr00t-native" if groot else "robocasa365-atomic-seen-native",
        "adapter": str(HERE / "adapter.py"),
        "path": str(args.robocasa_source.resolve()),
        "config": {"image": image_id(args.benchmark_image), "python": "/usr/local/bin/python",
                   "reference": json.dumps(reference), "profileDigest": digest(reference),
                   "implementationDigest": implementation_digest(),
                   "simGpus": "1", "renderer": "egl", "simGpuMemGB": "4"},
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for filename, value in (("policy.json", policy), ("benchmark.json", benchmark), ("reference.json", reference)):
        (args.output_dir / filename).write_text(json.dumps(value, indent=2) + "\n")
    print("Wrote the pinned RoboCasa365 registrations and sample-plan reference.")


if __name__ == "__main__":
    main()
