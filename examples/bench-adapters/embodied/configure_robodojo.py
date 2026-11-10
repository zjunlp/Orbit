"""Register all pinned RoboDojo tasks without selecting or installing a policy."""

import argparse
import ast
import json
from pathlib import Path
import re
import subprocess

from adapter import HERE, check_source, digest, file_digest, implementation_digest
from configure_groot import image_id
from orbit_embodied.assets import tree_digest


PROFILE = HERE / "profiles/robodojo-native.json"
SOURCE_DIRS = ("env", "env_cfg", "task/RoboDojo", "utils", "src/eval_client")


DEPENDENCIES = {"xpolicylab": ("XPolicyLab", ("client_server",)),
                "isaaclab": ("third_party/IsaacLab", ("source", "apps", "isaaclab.sh", "environment.yml", "pyproject.toml")),
                "curobo": ("third_party/curobo", ("curobo", "setup.py", "pyproject.toml"))}



def runtime_manifest(root, reference):
    source = reference["reference"]
    check_source(root, source["evaluation"], source["files"])
    files, commits = {}, {}
    for key, (relative, scopes) in DEPENDENCIES.items():
        directory = root / relative
        git = ["git", "-C", str(directory)]
        expected = source[key]["commit"]
        actual = subprocess.check_output(git + ["rev-parse", "HEAD"], text=True).strip()
        if actual != expected:
            raise ValueError("initialize the pinned RoboDojo submodule: " + relative)
        if subprocess.check_output(git + ["status", "--porcelain", "--untracked-files=all", "--", *scopes], text=True):
            raise ValueError("RoboDojo dependency source must be clean: " + relative)
        for scope in scopes:
            if not (directory / scope).exists():
                raise ValueError("missing dependency runtime scope: " + relative + "/" + scope)
        names = subprocess.check_output(git + ["ls-files", "--", *scopes], text=True).splitlines()
        for scope in scopes:
            if not any(name == scope or name.startswith(scope + "/") for name in names):
                raise ValueError("empty dependency runtime scope: " + relative + "/" + scope)
        for name in names:
            path = directory / name
            if path.is_symlink():
                raise ValueError("RoboDojo runtime source cannot contain symlinks: " + str(path))
            files[relative + "/" + name] = file_digest(path)
        if not any(name.startswith(relative + "/") for name in files):
            raise ValueError("missing dependency runtime source: " + relative)
        commits[key] = expected
    return {"version": 1, "commits": commits, "files": files, "isaacsim": "5.1.0"}


def task_metadata(root, task):
    source = root / "task/RoboDojo/tasks" / (task + ".py")
    tree = ast.parse(source.read_text(encoding="utf-8"))
    limits = [ast.literal_eval(node.value) for node in ast.walk(tree) if isinstance(node, ast.Assign)
              and any(isinstance(target, ast.Attribute) and target.attr == "step_lim" for target in node.targets)]
    if len(limits) != 1 or type(limits[0]) is not int or limits[0] < 1:
        raise ValueError("cannot freeze native RoboDojo horizon for " + task)
    return {"horizon": limits[0],
            "partialScore": any(isinstance(node, ast.FunctionDef) and node.name == "get_score"
                                for node in ast.walk(tree))}


def reject_asset_pointers(assets):
    for path in assets.rglob("*"):
        if path.is_file() and path.stat().st_size < 1024:
            with path.open("rb") as stream:
                if stream.read(64).startswith(b"version https://git-lfs.github.com/spec/v1"):
                    raise ValueError("RoboDojo asset is a Git LFS pointer: " + path.relative_to(assets).as_posix())


def layout_catalog(assets, tasks):
    result, unsupported = {}, {}
    for task in tasks:
        result[task] = {}
        pattern = re.compile(re.escape(task) + r"_\d+\.json")
        for seed in range(3):
            folder = assets / "Eval_Layout/RoboDojo/arx_x5" / str(seed)
            files = sorted((path for path in folder.glob("*.json") if pattern.fullmatch(path.name)),
                           key=lambda path: int(path.stem.rsplit("_", 1)[1]))
            entries = []
            numbers = set()
            for ordinal, path in enumerate(files):
                number = int(path.stem.rsplit("_", 1)[1])
                if number in numbers:
                    raise ValueError("ambiguous numeric RoboDojo layout order: " + task)
                numbers.add(number)
                data = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(data, dict) or not data:
                    raise ValueError("RoboDojo layout must be a nonempty native scene object: " + str(path))
                entries.append({"id": ordinal, "file": path.relative_to(assets).as_posix(), "digest": file_digest(path)})
            result[task][str(seed)] = entries
        if not any(result[task].values()):
            unsupported[task] = "No frozen native replay layouts in eval partitions 0, 1, or 2."
    return result, unsupported


def configure_benchmark(args, reference):
    root, assets = args.robodojo_source.resolve(), args.assets.resolve()
    source = reference["reference"]
    check_source(root, source["evaluation"], source["files"])
    dirty = subprocess.check_output(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=all",
                                     "--", *SOURCE_DIRS], text=True)
    if dirty:
        raise ValueError("RoboDojo runtime source must match the clean pinned checkout")
    dependency_manifest = runtime_manifest(root, reference)
    environment = reference["environment"]
    for task in environment["tasks"]:
        current = task_metadata(root, task)
        expected = environment["catalog"][task]
        if any(current[key] != expected[key] for key in current):
            raise ValueError("native RoboDojo task metadata changed: " + task)
    for required in ("Robots", "Object", "Material", "Eval_Layout"):
        if not (assets / required).is_dir():
            raise ValueError("RoboDojo Assets is missing " + required)
    reject_asset_pointers(assets)
    layouts, unsupported = layout_catalog(assets, environment["tasks"])
    environment.update(layouts=layouts, unsupported=unsupported)
    environment["assets"].update(digest=tree_digest(assets), dataset=args.dataset)
    runtime_image = image_id(args.benchmark_image)
    manifest = subprocess.check_output(["docker", "image", "inspect", "--format",
        '{{index .Config.Labels "org.orbit.robodojo.manifest"}}', runtime_image], text=True).strip()
    if manifest != digest(source["files"]):
        raise ValueError("build the RoboDojo image with the provided source-manifest check")
    runtime_label = subprocess.check_output(["docker", "image", "inspect", "--format",
        '{{index .Config.Labels "org.orbit.robodojo.runtime-manifest"}}', runtime_image], text=True).strip()
    if runtime_label != digest(dependency_manifest):
        raise ValueError("RoboDojo image dependencies differ from the pinned runtime manifest")
    source["runtimeManifestDigest"] = runtime_label
    source["files"].update(dependency_manifest["files"])
    return {
        "name": "robodojo-arx-x5-native", "path": str(root), "adapter": str(HERE / "adapter.py"),
        "resources": str((args.output_dir / "resources.json").resolve()),
        "labels": {"identity": {"id": "robodojo", "name": "RoboDojo"}},
        "config": {"image": runtime_image, "python": "/root/miniconda3/envs/RoboDojo/bin/python",
                   "reference": json.dumps(reference, separators=(",", ":")), "profileDigest": digest(reference),
                   "implementationDigest": implementation_digest(), "simGpus": "1", "simGpuMemGB": "16",
                   "renderer": "vulkan"},
    }


def resources():
    return {"version": 1, "note": "Provisional single native environment; calibrate with measured Orbit usage.",
            "default": {"gpus": 1, "gpuMemGB": 16, "cpus": 8, "memGB": 32, "timeoutMin": 60,
                        "evidence": "Pinned RoboDojo uses Isaac Sim 5.1 RTX rendering, three 640x480 cameras, "
                                    "CuRobo and task-specific simulation. No measured task peaks yet.",
                        "confidence": "low"}, "tasks": {}}


def hold_policy(reference, image):
    script = "/opt/orbit/hold_robodojo.py"
    python = "/root/miniconda3/envs/RoboDojo/bin/python"
    return {
        "name": "robodojo-hold-calibration", "version": "1", "kind": "calibration", "connector": "policy-ws",
        "replanSteps": 1, "profile": reference["benchmarkProfile"],
        "checkpointDigest": file_digest(HERE / "fixtures/hold_robodojo.py"),
        "normalizationDigest": digest({"normalization": "native absolute dual-X5 joints and normalized grippers", "version": 1}),
        "randomness": {"backend": "stateless", "scope": "stateless"},
        "service": {"name": "policy", "image": image, "entrypoint": python, "command": [script],
                    "cpus": 1, "memGB": 2, "gpus": 0,
                    "healthcheck": {"command": [python, script, "--healthcheck"],
                                    "intervalSec": 5, "timeoutSec": 5, "startPeriodSec": 15, "retries": 12}},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--robodojo-source", type=Path, required=True)
    parser.add_argument("--assets", type=Path)
    parser.add_argument("--dataset", default="robodojo-native-assets")
    parser.add_argument("--benchmark-image")
    parser.add_argument("--prepare-image", action="store_true", help="write pinned dependency manifest before image build")
    parser.add_argument("--benchmark-only", action="store_true", help="benchmark registration is always independent")
    parser.add_argument("--with-hold-calibration", action="store_true", help="emit an explicit hold-position calibration fixture")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    if args.benchmark_only and args.with_hold_calibration:
        parser.error("--benchmark-only cannot be combined with --with-hold-calibration")
    reference = json.loads(PROFILE.read_text())
    if args.prepare_image:
        manifest = runtime_manifest(args.robodojo_source.resolve(), reference)
        args.output_dir.mkdir(parents=True, exist_ok=True)
        (args.output_dir / "robodojo-runtime.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print(digest(manifest))
        return
    if args.assets is None or args.benchmark_image is None:
        parser.error("benchmark registration needs --assets and --benchmark-image")
    benchmark = configure_benchmark(args, reference)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    outputs = {"benchmark": benchmark, "reference": reference, "resources": resources()}
    if args.with_hold_calibration:
        outputs["hold-policy"] = hold_policy(reference, benchmark["config"]["image"])
    for name, value in outputs.items():
        (args.output_dir / (name + ".json")).write_text(json.dumps(value, indent=2) + "\n")
    print("Wrote all 54 native RoboDojo tasks, frozen layouts, assets, and provisional resource limits.")


if __name__ == "__main__":
    main()
