"""Read-only reference audit; write its output outside the source repository."""

import argparse
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(HERE), str(HERE.parents[1] / "sdk")]
from orbit_embodied import digest
from orbit_embodied.assets import checkpoint_tree_digest
from adapter import file_digest
from libero_source import audit_file, checkout_status, standalone_profile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference-source", type=Path, required=True)
    parser.add_argument("--libero-source", type=Path, help="Standalone official LIBERO checkout")
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--benchmark-image")
    parser.add_argument("--policy-image")
    args = parser.parse_args()
    reference = json.loads((HERE / "reference.json").read_text())
    libero = args.libero_source or args.reference_source / "third_party/libero"
    checks = []
    for name, path in (("openpi", args.reference_source), ("libero", libero)):
        revision, dirty = checkout_status(path)
        expected = reference["reference"][name]["commit"]
        checks.append({"check": name + " source", "result": "passed" if revision == expected and not dirty else "failed", "revision": revision})
    for relative, expected in reference["reference"]["files"].items():
        actual = file_digest(audit_file(args.reference_source, libero, relative))
        checks.append({"check": relative, "result": "passed" if actual == expected else "failed"})
    profile = standalone_profile(reference) if args.libero_source else reference
    result = {"reference": profile["id"], "profileDigest": digest(profile), "checks": checks,
              "checkpoint": {"result": "not_run"}, "images": {},
              "nativeParity": "not_run", "positiveCalibration": "not_run"}
    if args.checkpoint:
        measured = checkpoint_tree_digest(args.checkpoint)
        normalization = checkpoint_tree_digest(args.checkpoint / "assets")
        expected = reference["checkpoint"].get("contentDigest")
        expected_normalization = reference["checkpoint"].get("normalizationDigest")
        complete = all((args.checkpoint / name).is_dir() for name in reference["checkpoint"]["required"])
        status = "passed" if complete and measured == expected and normalization == expected_normalization else "failed" if expected else "not_run"
        result["checkpoint"] = {"result": status, "checkpointDigest": measured,
                                "normalizationDigest": normalization}
    for role, image in (("benchmark", args.benchmark_image), ("policy", args.policy_image)):
        if image:
            record = json.loads(subprocess.check_output(["docker", "image", "inspect", image], text=True))[0]
            labels = record.get("Config", {}).get("Labels") or {}
            result["images"][role] = {"result": "passed", "id": record["Id"], "repoDigests": record.get("RepoDigests", []),
                                     "buildInputs": {key: value for key, value in labels.items() if key.startswith("orbit.reference.")}}
        else:
            result["images"][role] = {"result": "not_run"}
    print(json.dumps(result, indent=2))
    return int(any(check["result"] == "failed" for check in checks) or result["checkpoint"]["result"] == "failed")


if __name__ == "__main__":
    sys.exit(main())
