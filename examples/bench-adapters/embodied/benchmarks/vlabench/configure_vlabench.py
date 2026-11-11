"""Generate the VLABench track registrations and, optionally, the OpenWAM policy."""

import argparse
import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import HERE, check_source, digest, file_digest, implementation_digest
from native_runtime import image_id
from orbit_embodied.assets import tree_digest
from orbit_embodied.vlabench import ASSETS_ROOT, CAMERAS, OPEN_TRACK, RENDER_SIZE, TRACKS, track_catalog, track_path


SOURCE = {"repository": "https://github.com/OpenMOSS/VLABench",
          "commit": "cf588fe60c0c7282174fe979f5913170cfe69017"}
OPENWAM_SOURCE = "090c4d41668fcb238d77d3d5a2da9183088b119c"
SOURCE_FILES = ("VLABench/configs/task_config.json", "VLABench/configs/__init__.py",
                "VLABench/configs/robot_config.json", "VLABench/configs/scene_config.json",
                "VLABench/evaluation/evaluator/base.py", "VLABench/envs/dm_env.py")
DATASET = "vlabench-assets"
POLICY_NAME = "openwam-alpha-sim-vlabench"
CHECKPOINT = "checkpoint_step_6000.safetensors"
NORMALIZATION = "normalization_stats.npy"
TOKENIZER = "tokenizer/google/umt5-xxl/spiece.model"
RANDOMNESS = {"backend": "stateless", "scope": "stateless"}


def profiles():
    observations = {field: {"semantic": "rgb", "dtype": "uint8", "shape": [RENDER_SIZE, RENDER_SIZE, 3],
                            "camera": camera, "layout": "HWC"}
                    for field, (_, camera) in CAMERAS.items()}
    observations.update({
        "ee_state": {"semantic": "franka-ee-position-orientation-and-closed-state", "dtype": "float64",
                     "shape": [8], "frame": "world", "unit": "metres-quaternion-binary",
                     "format": "xyz-wxyz-1-closed"},
        "robot_base": {"semantic": "robot-base-position", "dtype": "float64",
                       "shape": [3], "frame": "world", "unit": "metre"},
        "instruction": {"semantic": "task-language", "dtype": "string", "shape": []},
    })
    action = {"semantic": "vlabench-absolute-ee-and-finger-width", "shape": [8],
              "controller": "vlabench-franka-ik", "frame": "world", "unit": "metres-radians",
              "rotation": "euler-xyz", "gripper": "two-finger-positions-in-metres",
              "order": ["x", "y", "z", "roll", "pitch", "yaw", "left_finger", "right_finger"]}
    benchmark = {"id": "vlabench-franka-ee/1", "observations": observations, "action": action}
    policy = {**benchmark, "id": "openwam-vlabench-input/1",
              "observations": {name: spec for name, spec in observations.items() if name != "left_rgb"}}
    return benchmark, policy


def policy_definition(weights, image, profile):
    for name in (CHECKPOINT, "config.yaml", NORMALIZATION, TOKENIZER):
        if not (weights / name).is_file():
            raise ValueError("OpenWAM checkpoint is incomplete: " + name)
    if any(weights.rglob("*.partial*")):
        raise ValueError("OpenWAM checkpoint has partial downloads")
    image = image_id(image)
    revision = subprocess.check_output(["docker", "image", "inspect", "--format",
                                        '{{index .Config.Labels "org.opencontainers.image.revision"}}',
                                        image], text=True).strip()
    if revision != OPENWAM_SOURCE:
        raise ValueError("OpenWAM image must be built from the pinned upstream revision")
    checkpoint, normalization = tree_digest(weights), file_digest(weights / NORMALIZATION)
    return {"name": POLICY_NAME, "version": "1", "connector": "policy-ws", "replanSteps": 1,
            "port": 8000, "callTimeoutSec": 300, "randomness": RANDOMNESS, "profile": profile,
            "checkpointDigest": checkpoint, "normalizationDigest": normalization,
            "weights": {"dataset": POLICY_NAME, "target": "/weights"},
            "service": {"name": "policy", "image": image, "gpusOf": "main", "gpus": 0,
                        "gpuMemGB": 48, "memGB": 64, "cpus": 6,
                        "command": ["--checkpoint", "/weights", "--checkpoint-digest", checkpoint,
                                    "--normalization-digest", normalization],
                        "healthcheck": {"command": ["/opt/venv/bin/python", "/opt/orbit/serve_openwam.py", "--healthcheck"],
                                        "intervalSec": 5, "timeoutSec": 5, "startPeriodSec": 300, "retries": 90},
                        }}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--benchmark-image", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--policy-image")
    args = parser.parse_args()
    if bool(args.weights) != bool(args.policy_image):
        parser.error("--weights and --policy-image must be used together")
    root = args.source.resolve()
    files = {name: file_digest(root / name) for name in SOURCE_FILES}
    check_source(root, SOURCE, files)
    if any(not (args.assets / folder).is_dir() for folder in ("obj/meshes", "scenes")):
        parser.error("--assets must contain the extracted obj and scenes directories")
    assets = {"dataset": DATASET, "target": ASSETS_ROOT, "digest": tree_digest(args.assets)}
    image = image_id(args.benchmark_image)
    implementation = implementation_digest()
    benchmark_profile, policy_profile = profiles()
    for number, track in enumerate(TRACKS, 1):
        tasks, horizons, counts = track_catalog(root, track)
        environment = {"kind": "vlabench", "track": track, "tasks": tasks, "horizons": horizons, "assets": assets}
        track_files = files.copy()
        if track != OPEN_TRACK:
            environment["vlabenchEpisodeCounts"] = counts
            name = "VLABench/" + track_path(track)
            track_files[name] = file_digest(root / name)
        reference = {
            "id": "vlabench-track-" + str(number) + "-native/1",
            "environment": environment,
            "parameters": {"replanSteps": 1, "settleSteps": 0, "renderSize": RENDER_SIZE},
            "reference": {"evaluation": SOURCE, "files": track_files,
                          "sceneCompatibility": file_digest(Path(__file__).resolve().with_name("prepare_vlabench.py"))},
            "benchmarkProfile": benchmark_profile,
            "policyProfile": policy_profile,
            "observationMap": {field: field for field in policy_profile["observations"]},
            "scoreName": "VLABench track " + str(number) + " mean task success",
            "scoreErrors": "exclude", "scoreUnit": "task",
        }
        name = "vlabench-track-" + str(number) + "-native"
        benchmark = {"name": name, "path": str(root), "adapter": str(HERE / "adapter.py"), "config": {
            "image": image, "python": "/usr/local/bin/python", "renderer": "egl",
            "simGpus": "1", "simGpuMemGB": "4", "reference": json.dumps(reference, separators=(",", ":")),
            "profileDigest": digest(reference), "implementationDigest": implementation,
        }}
        output = args.output_dir / ("track-" + str(number))
        output.mkdir(parents=True, exist_ok=True)
        for filename, value in (("benchmark.json", benchmark), ("reference.json", reference)):
            (output / filename).write_text(json.dumps(value, indent=2) + "\n")
        scope = str(sum(counts.values())) + " fixed episodes" if counts else "seeded episodes"
        print(f"{name}: {len(tasks)} tasks, {scope}")
    if args.weights:
        policy = policy_definition(args.weights, args.policy_image, policy_profile)
        (args.output_dir / "policy.json").write_text(json.dumps(policy, indent=2) + "\n")


if __name__ == "__main__":
    main()
