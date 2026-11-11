"""Generate benchmark-only registrations for the pinned official RoboLab catalog."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import HERE, digest, file_digest, implementation_digest
from native_runtime import image_id
from orbit_embodied.robolab import check_assets


REVISION = "9cce00cadd5dc575fd2b8ea3836f5bdcde574229"
PROFILE = HERE / "profiles/robolab-native.json"


def published_asset_digest(source):
    archive = subprocess.check_output(["git", "-C", str(source), "archive", REVISION, "assets"])
    entries = []
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        for member in stream.getmembers():
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError("the pinned RoboLab asset tree contains a non-regular file")
            content = stream.extractfile(member).read()
            if content.startswith(b"version https://git-lfs.github.com/spec/v1\n"):
                fields = dict(line.split(" ", 1) for line in content.decode().splitlines())
                checksum, size = fields["oid"], int(fields["size"])
            else:
                checksum, size = "sha256:" + hashlib.sha256(content).hexdigest(), len(content)
            entries.append({"path": member.name[len("assets/"):], "size": size, "digest": checksum})
    return digest(sorted(entries, key=lambda row: Path(row["path"])))


def reference_for(source, assets, tasks=None, replan_steps=1):
    source = Path(source).resolve()
    if subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip() != REVISION:
        raise ValueError("expected the pinned official NVlabs/RoboLab checkout")
    files = ["pyproject.toml", *sorted(path.relative_to(source).as_posix()
                                     for path in (source / "robolab").rglob("*.py"))]
    subprocess.run(["git", "-C", str(source), "diff", "--quiet", "HEAD", "--", *files], check=True)
    untracked = subprocess.check_output(["git", "-C", str(source), "ls-files", "--others", "--exclude-standard",
                                        "--", "robolab"], text=True)
    if untracked.strip():
        raise ValueError("RoboLab source contains untracked files")
    reference = json.loads(PROFILE.read_text())
    environment = reference["environment"]
    selected = environment["tasks"] if tasks is None else list(tasks)
    if not selected or len(selected) != len(set(selected)) or set(selected) - set(environment["tasks"]):
        raise ValueError("select unique tasks from the pinned RoboLab catalog")
    if type(replan_steps) is not int or replan_steps <= 0:
        raise ValueError("replan steps must be a positive integer")
    environment["tasks"] = selected
    for field in ("horizons", "instructions", "scenes"):
        environment[field] = {task: environment[field][task] for task in selected}
    environment["assets"]["digest"] = check_assets(assets, published_asset_digest(source))
    for scene in environment["scenes"].values():
        matches = [path for path in (Path(assets) / "scenes").rglob(Path(scene).name)
                   if path.as_posix().endswith("/" + scene)]
        if len(matches) != 1:
            raise ValueError("RoboLab scene asset is missing or ambiguous: " + scene)
    if not (Path(assets) / "robots/franka_robotiq_2f_85_flattened.usd").is_file():
        raise ValueError("RoboLab DROID robot asset is missing")
    reference["parameters"]["replanSteps"] = replan_steps
    reference["reference"]["files"] = {name: file_digest(source / name) for name in files}
    return reference


def hold_policy(reference, image):
    script = "/opt/orbit/hold_robolab.py"
    python = "/workspace/isaaclab/_isaac_sim/python.sh"
    return {
        "name": "robolab-hold-calibration", "version": "1", "kind": "calibration", "connector": "policy-ws",
        "replanSteps": reference["parameters"]["replanSteps"], "profile": reference["benchmarkProfile"],
        "checkpointDigest": file_digest(HERE / "fixtures/hold_robolab.py"),
        "normalizationDigest": digest({"normalization": "native absolute DROID joints and binary gripper", "version": 1}),
        "randomness": {"backend": "stateless", "scope": "stateless"},
        "service": {"name": "policy", "image": image, "entrypoint": python,
                    "command": [script, "--replan-steps", str(reference["parameters"]["replanSteps"])],
                    "cpus": 1, "memGB": 2, "gpus": 0,
                    "healthcheck": {"command": [python, script, "--healthcheck"],
                                    "intervalSec": 5, "timeoutSec": 5, "startPeriodSec": 15, "retries": 12}},
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--robolab-source", type=Path, required=True)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--benchmark-image", required=True)
    parser.add_argument("--benchmark-only", action="store_true", help="accepted for consistency; no policy is created")
    parser.add_argument("--with-hold-calibration", action="store_true", help="also emit an explicit hold-position calibration policy")
    parser.add_argument("--tasks", nargs="+", help="explicit subset; the default registers all 120 official tasks")
    parser.add_argument("--replan-steps", type=int, default=1)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    if args.benchmark_only and args.with_hold_calibration:
        parser.error("--benchmark-only cannot be combined with --with-hold-calibration")
    reference = reference_for(args.robolab_source, args.assets, args.tasks, args.replan_steps)
    output = args.output_dir.resolve()
    benchmark = {
        "name": "robolab-native", "path": str(args.robolab_source.resolve()),
        "adapter": str(HERE / "adapter.py"), "resources": str(output / "resources.json"),
        "labels": {"identity": {"id": "robolab", "name": "RoboLab"}, "taxonomy": {"domains": ["robotics"]}},
        "config": {"image": image_id(args.benchmark_image),
                   "python": "/workspace/isaaclab/_isaac_sim/python.sh",
                   "reference": json.dumps(reference), "profileDigest": digest(reference),
                   "implementationDigest": implementation_digest(), "simGpus": "1",
                   "simGpuMemGB": "16", "renderer": "vulkan"},
    }
    resources = {"version": 1, "default": {"cpus": 8, "memGB": 24, "gpus": 1, "gpuMemGB": 16,
                 "timeoutMin": 30, "confidence": "unmeasured",
                 "note": "Single environment estimate; calibrate native RTX rendering and peak memory."}, "tasks": {}}
    output.mkdir(parents=True, exist_ok=True)
    outputs = {"benchmark": benchmark, "reference": reference, "resources": resources}
    if args.with_hold_calibration:
        outputs["hold-policy"] = hold_policy(reference, benchmark["config"]["image"])
    for name, value in outputs.items():
        (output / (name + ".json")).write_text(json.dumps(value, indent=2) + "\n")


if __name__ == "__main__":
    main()
