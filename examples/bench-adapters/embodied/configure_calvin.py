"""Register native CALVIN ABC-to-D evaluation and its independent RLinf pi0.5 policy."""

import argparse
import json
from pathlib import Path
import subprocess

from adapter import HERE, digest, file_digest, implementation_digest
from configure_groot import image_id
from configure_tabletop import RLINF_REVISION
from orbit_embodied.assets import tree_digest
from serve_metaworld import CALVIN_NORMALIZATION_DIR


TASK = "calvin-abc-d"
FILES = ("toolkits/standalone_eval_scripts/openpi/calvin_eval.py",
         "rlinf/envs/sim/calvin/utils.py",
         "rlinf/envs/sim/calvin/calvin_cfg/.hydra/merged_config.yaml",
         "rlinf/models/embodiment/openpi/policies/calvin_policy.py",
         "rlinf/models/embodiment/openpi/dataconfig/calvin_dataconfig.py")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference-source", type=Path, required=True)
    parser.add_argument("--sequence-catalog", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--benchmark-image", required=True)
    parser.add_argument("--policy-image", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    root = args.reference_source.resolve()
    git = ["git", "-C", str(root)]
    if subprocess.check_output(git + ["rev-parse", "HEAD"], text=True).strip() != RLINF_REVISION:
        raise ValueError("expected the pinned RLinf CALVIN reference")
    subprocess.run(git + ["diff", "--quiet", "HEAD", "--", *FILES], check=True)
    catalog = json.loads(args.sequence_catalog.read_text())
    states, sequences, instructions = catalog["states"], catalog["sequences"], catalog["instructions"]
    if (len(sequences) != 1000 or any(len(robot) != 15 or len(scene) != 24 for robot, scene in states)
            or any(not 0 <= index < len(states) or len(chain) != 5 or any(task not in instructions for task in chain)
                   for index, chain in sequences)):
        raise ValueError("expected 1000 five-subtask sequences and their native initial states")

    fields = {
        "front_rgb": {"semantic": "rgb", "camera": "static", "dtype": "uint8", "layout": "HWC",
                      "shape": [200, 200, 3]},
        "wrist_rgb": {"semantic": "rgb", "camera": "gripper", "dtype": "uint8", "layout": "HWC",
                      "shape": [84, 84, 3]},
        "state": {"semantic": "calvin-ee-position-euler-gripper-width", "dtype": "float32", "shape": [7],
                  "frame": "world", "unit": "metres-radians-and-gripper-width",
                  "order": ["x", "y", "z", "roll", "pitch", "yaw", "gripper"]},
        "instruction": {"semantic": "language-instruction", "dtype": "string", "shape": []},
    }
    action = {"semantic": "calvin-relative-ee-and-gripper", "shape": [7],
              "controller": "calvin-relative-tcp", "frame": "calvin-world",
              "unit": "controller-normalized", "rotation": "delta-euler", "gripper": "signed-open-close"}
    profile = {"id": "calvin-native/1", "observations": fields, "action": action}
    reference = {
        "id": TASK + "-rlinf/1",
        "environment": {"kind": "calvin", "tasks": [TASK], "horizon": 2400, "catalog": catalog},
        "parameters": {"replanSteps": 5, "settleSteps": 0, "subtaskSteps": 480, "successRule": "last"},
        "benchmarkProfile": profile,
        "policyProfile": {**profile, "id": "calvin-pi05-input/1"},
        "observationMap": {name: name for name in fields},
        "reference": {"evaluation": {"repository": "https://github.com/RLinf/RLinf", "commit": RLINF_REVISION},
                      "simulator": {"repository": "https://github.com/mees/calvin_env",
                                    "commit": "1431a46bd36bde5903fb6345e68b5ccc30def666"},
                      "files": {name: file_digest(root / name) for name in FILES}},
        "randomness": {"referenceEnvironment": "Pinned RLinf scene-D initial states and task chains.",
                       "referencePolicy": "Torch seed 0 per policy service."},
        "scoreName": "CALVIN mean completed subtasks",
    }
    checkpoint = tree_digest(args.weights)
    normalization = file_digest(args.weights / CALVIN_NORMALIZATION_DIR / "norm_stats.json")
    name = "pi05-rlinf-calvin-abc-d"
    policy = {"name": name, "version": "1", "connector": "policy-ws", "replanSteps": 5,
              "profile": reference["policyProfile"], "checkpointDigest": checkpoint,
              "normalizationDigest": normalization, "randomness": {"backend": "torch", "initialSeed": 0, "scope": "service"},
              "weights": {"dataset": name, "target": "/weights"}, "service": {
                  "name": "policy", "image": image_id(args.policy_image), "gpusOf": "main", "gpus": 0,
                  "gpuMemGB": 24, "memGB": 32, "cpus": 4,
                  "command": ["--recipe", "calvin", "--checkpoint", "/weights", "--checkpoint-digest", checkpoint,
                              "--normalization-digest", normalization],
                  "healthcheck": {"command": ["/.venv/bin/python", "/opt/orbit/serve_metaworld.py", "--healthcheck"],
                                  "intervalSec": 5, "timeoutSec": 5, "startPeriodSec": 300, "retries": 90},
              }}
    benchmark = {"name": TASK + "-native", "path": str(root), "adapter": str(HERE / "adapter.py"), "config": {
                     "image": image_id(args.benchmark_image), "python": "/usr/local/bin/python",
                     "reference": json.dumps(reference, separators=(",", ":")), "profileDigest": digest(reference),
                     "implementationDigest": implementation_digest(), "simGpus": "1", "simGpuMemGB": "4",
                     "renderer": "egl",
                 }}
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name, value in (("benchmark", benchmark), ("policy", policy), ("reference", reference)):
        (args.output_dir / (name + ".json")).write_text(json.dumps(value, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
