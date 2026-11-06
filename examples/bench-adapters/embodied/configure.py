"""Generate local registrations from an audited checkpoint and immutable images."""

import argparse
import json
from pathlib import Path

from adapter import HERE, digest, implementation_digest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--reference-source", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--suite", default="libero_spatial")
    args = parser.parse_args()
    audit = json.loads(args.audit.read_text())
    if audit["checkpoint"]["result"] != "passed" or any(row["result"] != "passed" for row in audit["checks"]):
        raise ValueError("source and checkpoint audit must pass first")
    if any(audit["images"][role]["result"] != "passed" for role in ("benchmark", "policy")):
        raise ValueError("both runtime images must be audited")
    reference = json.loads((HERE / "reference.json").read_text())
    if digest(reference) != audit["profileDigest"]:
        raise ValueError("audit is for another reference profile")
    checkpoint = audit["checkpoint"]
    policy = {
        "name": "pi05-libero", "version": "1", "connector": "openpi-ws", "callTimeoutSec": 300,
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
    benchmark = {
        "name": "libero-native", "adapter": str(HERE / "adapter.py"),
        "path": str(args.reference_source.resolve()), "config": {
            "image": audit["images"]["benchmark"]["id"], "profileDigest": audit["profileDigest"],
            "reference": json.dumps(reference), "implementationDigest": implementation_digest(),
            "suite": args.suite, "renderer": "osmesa", "simGpus": "0"},
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for filename, value in (("policy.json", policy), ("benchmark.json", benchmark)):
        (args.output_dir / filename).write_text(json.dumps(value, indent=2) + "\n")
    print("Wrote policy.json and benchmark.json; register them through the Orbit API.")


if __name__ == "__main__":
    main()
