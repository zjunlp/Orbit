"""Generate independent registrations from audited local sources, assets and images."""

import argparse
import json
import math
from pathlib import Path
import subprocess

from adapter import HERE, digest, file_digest, implementation_digest, pinned
from orbit_embodied.assets import tree_digest


def image_id(image):
    value = subprocess.check_output(["docker", "image", "inspect", "--format", "{{.Id}}", image], text=True).strip()
    if not pinned(value):
        raise ValueError("runtime image must have an immutable content identity")
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference-source", type=Path, required=True)
    parser.add_argument("--benchmark-source", type=Path)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--profile", choices=("libero", "widowx"), required=True)
    parser.add_argument("--policy-image", required=True)
    parser.add_argument("--benchmark-image", required=True)
    parser.add_argument("--share-gpu", action="store_true")
    parser.add_argument("--sim-gpu-mem-gb", type=float, default=4.0, help="Simulator memory budget per GPU in GB")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    if not math.isfinite(args.sim_gpu_mem_gb) or args.sim_gpu_mem_gb <= 0:
        parser.error("sim-gpu-mem-gb must be finite and positive")
    model_reference = json.loads((HERE / "profiles/groot-model.json").read_text())
    for name, expected in model_reference["files"].items():
        if file_digest(args.reference_source / name) != expected:
            raise ValueError("model reference source content changed: " + name)
    reference_file = HERE / "reference.json" if args.profile == "libero" else HERE / "profiles/groot-widowx.json"
    reference = json.loads(reference_file.read_text())
    if args.profile == "libero" and args.benchmark_source is None:
        parser.error("LIBERO reuses the pinned OpenPI benchmark; provide --benchmark-source")
    root = (args.benchmark_source or args.reference_source).resolve()
    for name, expected in reference["reference"]["files"].items():
        if file_digest(root / name) != expected:
            raise ValueError("reference source content changed: " + name)
    checkpoint = args.weights / ("libero_spatial" if args.profile == "libero" else "bridge")
    index = json.loads((checkpoint / "model.safetensors.index.json").read_text())
    if any(not (checkpoint / name).is_file() for name in set(index["weight_map"].values())):
        raise ValueError("checkpoint download is incomplete")
    if list(args.weights.rglob("*.partial")):
        raise ValueError("asset downloads are still in progress")
    model = tree_digest(checkpoint)
    normalization = file_digest(checkpoint / "statistics.json")
    backbone = tree_digest(args.weights / "hub")
    model_image, benchmark_image = image_id(args.policy_image), image_id(args.benchmark_image)
    embodiment = "LIBERO_PANDA" if args.profile == "libero" else "SIMPLER_ENV_WIDOWX"
    name = "groot-n17-" + args.profile
    runtime_checkpoint = "/weights/" + checkpoint.name
    service = {
        "name": "policy", "image": model_image, "cpus": 4, "memGB": 32, "gpuMemGB": 24,
        "command": ["/opt/orbit/serve_groot.py", "--checkpoint", runtime_checkpoint,
                    "--backbone-cache", "/weights/hub", "--embodiment", embodiment,
                    "--checkpoint-digest", model, "--normalization-digest", normalization,
                    "--backbone-digest", backbone],
        "healthcheck": {"command": ["python", "/opt/orbit/serve_groot.py", "--healthcheck"],
                        "intervalSec": 5, "timeoutSec": 5, "startPeriodSec": 300, "retries": 90},
    }
    if args.share_gpu:
        service.update(gpusOf="main", gpus=0)
    else:
        service.update(role="policy", gpus=1)
    policy = {
        "name": name, "version": "1.7", "kind": "model", "connector": "groot-zmq", "port": 5555,
        "replanSteps": reference["parameters"]["replanSteps"], "callTimeoutSec": 300,
        "ioAdapter": "libero-native" if args.profile == "libero" else "gr00t-flat",
        "randomness": {"backend": "torch", "initialSeed": 0, "scope": "service"},
        "profile": {**reference["policyProfile"], "id": "groot-" + args.profile + "-input/1"}, "checkpointDigest": model,
        "normalizationDigest": normalization, "backboneDigest": backbone, "service": service,
        "weights": {"dataset": "groot-n17", "target": "/weights"},
    }
    gpu_sim = args.profile == "widowx" or args.share_gpu
    benchmark = {
        "name": "libero-native" if args.profile == "libero" else "simpler-widowx-native",
        "adapter": str(HERE / "adapter.py"), "path": str(root),
        "config": {"image": benchmark_image, "python": "/.venv/bin/python" if args.profile == "libero" else "/usr/local/bin/python", "reference": json.dumps(reference),
                   "profileDigest": digest(reference), "implementationDigest": implementation_digest(),
                   "simGpus": "1" if gpu_sim else "0", "renderer": "vulkan" if args.profile == "widowx" else "egl" if gpu_sim else "osmesa",
                   **({"simGpuMemGB": str(args.sim_gpu_mem_gb)} if gpu_sim else {})},
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for filename, value in (("policy.json", policy), ("benchmark.json", benchmark), ("reference.json", reference)):
        (args.output_dir / filename).write_text(json.dumps(value, indent=2) + "\n")
    print("Wrote pinned policy, benchmark and reference registrations; register them through the Orbit API.")


if __name__ == "__main__":
    main()
