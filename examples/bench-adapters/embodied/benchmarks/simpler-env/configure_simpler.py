"""Register a native SimplerEnv suite independently of any model weights."""

import argparse
import ast
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import HERE, check_source, digest, file_digest, implementation_digest
from native_runtime import image_id

SIMPLER = "external_dependencies/SimplerEnv/"
PROFILES = {
    "google-prepackaged": "Google Robot prepackaged",
    "widowx-prepackaged": "WidowX prepackaged",
    "google-visual-matching": "Google Robot Visual Matching",
    "google-variant-aggregation": "Google Robot Variant Aggregation",
    "widowx-visual-matching": "WidowX Visual Matching",
}


def prepackaged_catalog(source, robot):
    tree = ast.parse((source / SIMPLER / "simpler_env/__init__.py").read_text())
    environments = next(node.value for node in tree.body if isinstance(node, ast.Assign)
                        and any(isinstance(target, ast.Name) and target.id == "ENVIRONMENTS"
                                for target in node.targets))
    prefix = "google_robot_" if robot == "google" else "widowx_"
    return [task for task in ast.literal_eval(environments) if task.startswith(prefix)]


def expand_sweeps(families, robot):
    scenes = {}
    for family in families.values():
        defaults = family["defaults"]
        for group in family["groups"]:
            for task, variant in group["tasks"].items():
                rows = []
                for setting in group["settings"]:
                    build = {**defaults.get("build", {}), **variant.get("build", {}), **setting.get("build", {})}
                    rows.append({**defaults, **variant, **setting, "build": build})
                scenes[f"simpler_env_{robot}/{task}"] = rows
    return scenes


def reference_for(profile, root):
    robot = profile.split("-", 1)[0]
    reference = json.loads((HERE / f"profiles/groot-{robot}.json").read_text())
    reference["id"] = f"simpler-{profile}-reference/1"
    reference["scoreName"] = f"SimplerEnv {PROFILES[profile]} native success"
    reference["environment"]["simplerRobot"] = robot
    sources = reference["reference"]
    sources["wrapper"] = sources["evaluation"]
    sources["evaluation"] = {"repository": "https://github.com/squarefk/SimplerEnv",
                             "commit": sources["simpler"]["commit"]}
    if profile.endswith("-prepackaged"):
        names = prepackaged_catalog(root, robot)
        reference["environment"]["tasks"] = [f"simpler_env_{robot}/{name}" for name in names]
        if robot == "widowx":
            reference["environment"]["controlRates"] = {
                f"simpler_env_widowx/widowx_{motion}_drawer": 3 for motion in ("open", "close")
            }
    else:
        sweep = json.loads((HERE / "profiles/simpler-sweeps.json").read_text())
        prefix = SIMPLER + "ManiSkill2_real2sim/"
        sources["files"].update({SIMPLER + name: checksum for name, checksum in sweep["files"].items()})
        scenes = expand_sweeps(sweep["profiles"][profile], robot)
        for overlay in {row["overlay"] for rows in scenes.values() for row in rows if "overlay" in row}:
            filename = prefix + "data/" + overlay
            sources["files"][filename] = file_digest(root / filename)
        environment = reference["environment"]
        environment.pop("horizon")
        environment["tasks"] = list(scenes)
        environment["simplerScenes"] = scenes
        environment["horizons"] = {}
        for task, rows in scenes.items():
            (horizon,) = {row["horizon"] for row in rows}
            (rate,) = {row["controlHz"] for row in rows}
            if rate != reference["parameters"]["controlHz"]:
                raise ValueError("sweep control frequency differs from the robot reference")
            environment["horizons"][task] = horizon
        reference["scoreUnit"] = "task"
    return reference


def use_policy_termination(reference, root):
    environment = reference["environment"]
    environment["policyTermination"] = True
    profile = reference["benchmarkProfile"]
    profile["id"] = f"simpler-{environment['simplerRobot']}-policy-termination/1"
    action = profile["action"]
    action.update(semantic="simpler-native-action-and-terminate", shape=[8],
                  unit="translation:metre;rotation:radian;terminate:positive",
                  gripper="native-controller-action", order=[*action["order"], "terminate"])
    reference["policyProfile"] = profile
    reference["parameters"].update(replanSteps=1, successRule="last")
    evaluator = SIMPLER + "simpler_env/evaluation/maniskill2_evaluator.py"
    reference["reference"]["files"][evaluator] = file_digest(root / evaluator)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference-source", type=Path, required=True)
    parser.add_argument("--profile", choices=PROFILES, required=True)
    parser.add_argument("--benchmark-image", required=True)
    parser.add_argument("--disable-rt-denoiser", action="store_true",
                        help="Register a separate RT profile without OptiX denoising")
    parser.add_argument("--policy-termination", action="store_true",
                        help="Use native 7-D actions plus the RT-1/Octo termination output")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    root = args.reference_source.resolve()
    profile = args.profile
    reference = reference_for(profile, root)
    if args.policy_termination:
        if "simplerScenes" not in reference["environment"]:
            parser.error("--policy-termination requires a published scene grid")
        use_policy_termination(reference, root)
        profile += "-stop"
        reference["id"] = f"simpler-{profile}-reference/1"
        reference["scoreName"] = f"SimplerEnv {PROFILES[args.profile]} policy stop success"
    if args.disable_rt_denoiser:
        if args.profile == "widowx-visual-matching":
            parser.error("the WidowX Visual Matching sweep does not use ray tracing")
        profile += "-no-rt-denoiser"
        reference["id"] = f"simpler-{profile}-reference/1"
        suffix = " (no OptiX)" if args.policy_termination or args.profile == "google-variant-aggregation" else " (RT denoising disabled)"
        reference["scoreName"] += suffix
        reference["environment"]["rtDenoiser"] = False
    source = reference["reference"]
    check_source(root, source["wrapper"], source["files"])
    check_source(root / SIMPLER, source["evaluation"], {})
    check_source(root / SIMPLER / "ManiSkill2_real2sim",
                 {"commit": source["simpler"]["maniskillCommit"], "repository": "ManiSkill2_real2sim"}, {})
    benchmark = {
        "name": f"simpler-{profile}-native",
        "adapter": str(HERE / "adapter.py"),
        "path": str(root),
        "config": {"image": image_id(args.benchmark_image), "python": "/usr/local/bin/python",
                   "reference": json.dumps(reference), "profileDigest": digest(reference),
                   "implementationDigest": implementation_digest(),
                   "simGpus": "1", "simGpuMemGB": "4.0", "renderer": "vulkan"},
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name, value in (("benchmark.json", benchmark), ("reference.json", reference)):
        (args.output_dir / name).write_text(json.dumps(value, indent=2) + "\n")


if __name__ == "__main__":
    main()
