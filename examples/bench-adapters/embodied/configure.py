"""Generate a native LIBERO registration and an optional audited pi05 policy."""

import argparse
import json
import math
from pathlib import Path

from adapter import HERE, digest, implementation_digest
from orbit_embodied.libero_suites import HORIZONS, benchmark_name


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--benchmark-only", action="store_true")
    parser.add_argument("--reference-source", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--suite", choices=tuple(HORIZONS), default="libero_spatial")
    parser.add_argument("--share-gpu", action="store_true")
    parser.add_argument("--sim-gpu-mem-gb", type=float, default=4.0)
    args = parser.parse_args()
    if not math.isfinite(args.sim_gpu_mem_gb) or args.sim_gpu_mem_gb <= 0:
        parser.error("sim-gpu-mem-gb must be finite and positive")
    audit = json.loads(args.audit.read_text())
    if any(row["result"] != "passed" for row in audit["checks"]):
        raise ValueError("source audit must pass first")
    if audit["images"]["benchmark"]["result"] != "passed":
        raise ValueError("the benchmark image must be audited")
    reference = json.loads((HERE / "reference.json").read_text())
    if digest(reference) != audit["profileDigest"]:
        raise ValueError("audit is for another reference profile")
    if not args.benchmark_only and (
            audit["checkpoint"]["result"] != "passed" or audit["images"]["policy"]["result"] != "passed"):
        raise ValueError("checkpoint and policy image audit must pass first")

    benchmark = {
        "name": benchmark_name(args.suite), "adapter": str(HERE / "adapter.py"),
        "path": str(args.reference_source.resolve()), "config": {
            "image": audit["images"]["benchmark"]["id"], "profileDigest": audit["profileDigest"],
            "reference": json.dumps(reference), "implementationDigest": implementation_digest(),
            "suite": args.suite, "python": "/.venv/bin/python",
            "renderer": "egl" if args.share_gpu else "osmesa", "simGpus": "1" if args.share_gpu else "0",
            **({"simGpuMemGB": str(args.sim_gpu_mem_gb)} if args.share_gpu else {})},
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "benchmark.json").write_text(json.dumps(benchmark, indent=2) + "\n")
    if args.benchmark_only:
        print("Wrote benchmark.json; register it through the Orbit API.")
        return

    checkpoint = audit["checkpoint"]
    policy = {
        "name": "pi05-libero-shared" if args.share_gpu else "pi05-libero",
        "version": "1", "connector": "openpi-ws", "callTimeoutSec": 300,
        "profile": reference["policyProfile"], "checkpointDigest": checkpoint["checkpointDigest"],
        "normalizationDigest": checkpoint["normalizationDigest"],
        "weights": {"dataset": "pi05-libero", "target": "/weights"},
        "service": {"name": "policy", "image": audit["images"]["policy"]["id"],
                    "role": "policy", "gpus": 1, "gpuMemGB": 24, "cpus": 4, "memGB": 32,
                    "command": ["/opt/orbit/serve_openpi.py", "--config", "pi05_libero", "--checkpoint", "/weights",
                                "--checkpoint-digest", checkpoint["checkpointDigest"],
                                "--normalization-digest", checkpoint["normalizationDigest"]],
                    "healthcheck": {"command": ["/.venv/bin/python", "-c",
                        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5).read()"],
                        "intervalSec": 10, "timeoutSec": 6, "startPeriodSec": 300, "retries": 90}},
    }
    if args.share_gpu:
        policy["service"].pop("role")
        policy["service"].update(gpusOf="main", gpus=0)
    (args.output_dir / "policy.json").write_text(json.dumps(policy, indent=2) + "\n")
    print("Wrote policy.json and benchmark.json; register them through the Orbit API.")


if __name__ == "__main__":
    main()
