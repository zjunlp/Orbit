"""Build and register the pinned native VLA-Arena benchmark."""

import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import random
import subprocess
import tempfile
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from adapter import HERE, SDK, check_source, digest, file_digest, implementation_digest
from native_runtime import MANIFEST_LABEL, export_source, image_id, require_image


SOURCE = {"repository": "https://github.com/PKU-Alignment/VLA-Arena",
          "commit": "babe582ebffc82b979b77964a7e56417d02f63a4"}
SOURCE_FILES = ("vla_arena/vla_arena/benchmark/__init__.py",
                "vla_arena/vla_arena/benchmark/vla_arena_suite_task_map.py",
                "vla_arena/vla_arena/envs/env_wrapper.py",
                "vla_arena/vla_arena/utils/eval_cost.py",
                "vla_arena/models/openvla_oft/evaluator.py",
                "vla_arena/configs/evaluation/openvla_oft.yaml")
SUITES = {
    "safety_cautious_grasp": (5, 5, 5),
    "safety_dynamic_obstacles": (5, 5, 5),
    "safety_hazard_avoidance": (5, 5, 5),
    "safety_state_preservation": (5, 5, 5),
    "safety_static_obstacles": (5, 5, 5),
    "distractor_dynamic_distractors": (5, 5, 5),
    "distractor_static_distractors": (5, 5, 5),
    "extrapolation_preposition_combinations": (5, 5, 5),
    "extrapolation_task_workflows": (5, 5, 5),
    "extrapolation_unseen_objects": (5, 5, 5),
    "long_horizon": (10, 5, 5),
}
VISUAL_PROBES = ("light_adjustment", "color_randomize", "camera_offset", "add_noise")
LANGUAGE_RELEASE = "0f3410ac91335a86aaca4141539c6385bfc7f158"
LANGUAGE_FILES = {
    1: "5a11963c5ef6d4a282cc8b1ba93918b85a3a86c0c9742cabb51385152b1bf5c3",
    2: "ac26f8e27826d8ff7ed7cf0166af670112bb9839f65eb86af35c92e171351853",
    3: "b3df8fd5681ccd6628e790943be106a65b8b9296ee687cdc232c625107214df5",
    4: "b59f18bdda660fdc65994348d4bceb7f06f3845812e1e5057a2d8edafba22bec",
}
DOCKERFILE = Path(__file__).resolve().with_name("vla-arena.Dockerfile")


def manifest(base):
    return {"kind": "vla-arena", "sources": {"vla-arena": SOURCE["commit"]},
            "dockerfile": file_digest(DOCKERFILE), "base": base, "entrypoint": ["python"]}


def build(args, record):
    with tempfile.TemporaryDirectory(prefix="orbit-vla-arena-") as directory:
        exported = Path(directory) / "arena"
        export_source(args.source, SOURCE, exported, ["vla_arena/__init__.py", "vla_arena/vla_arena"])
        label = MANIFEST_LABEL + "=" + json.dumps(record, sort_keys=True, separators=(",", ":"))
        subprocess.run(["docker", "build", "--label", "orbit.task=embodied-eval", "--label", label,
                        "--build-arg", "BENCHMARK_BASE=" + args.base_image,
                        "--build-context", "arena=" + str(exported), "-f", str(DOCKERFILE),
                        "-t", args.build_tag, str(HERE.parents[2])], check=True)


def get_catalog(image):
    prefix = "ORBIT_ARENA_CATALOG="
    code = ("import json; from orbit_embodied.vla_arena import native_catalog; "
            f"print({prefix!r} + json.dumps(native_catalog({SUITES!r})))")
    output = subprocess.check_output(
        ["docker", "run", "--rm", "--network", "none", "--label", "orbit.task=embodied-eval",
         "--mount", f"type=bind,src={SDK},dst=/orbit-sdk,readonly", "-e", "PYTHONPATH=/orbit-sdk",
         "-e", "MUJOCO_GL=osmesa", "-e", "PYOPENGL_PLATFORM=osmesa", image, "-B", "-c", code], text=True)
    line, = (line for line in output.splitlines() if line.startswith(prefix))
    return json.loads(line[len(prefix):])


def language_rows(path):
    """Stream the official JSON array, including the 752 MB W4 table."""
    decoder = json.JSONDecoder()
    with path.open(encoding="utf-8") as source:
        if source.read(1) != "[":
            raise ValueError("VLA-Arena replacement file must contain a JSON array")
        buffer, cursor = "", 0
        while True:
            while cursor < len(buffer) and (buffer[cursor].isspace() or buffer[cursor] == ","):
                cursor += 1
            if cursor < len(buffer) and buffer[cursor] == "]":
                return
            try:
                row, cursor = decoder.raw_decode(buffer, cursor)
            except json.JSONDecodeError:
                chunk = source.read(65536)
                if not chunk:
                    raise ValueError("VLA-Arena replacement JSON array is incomplete")
                buffer, cursor = buffer[cursor:] + chunk, 0
            else:
                if row.get("original") and row.get("modified"):
                    yield row["original"], row["modified"]


def freeze_replacements(path, catalog):
    keys = {task: row["instruction"].lower().replace(" ", "_") for task, row in catalog.items()}
    wanted = set(keys.values())
    counts = Counter(key for key, _ in language_rows(path) if key in wanted)
    selected = {}
    indices = defaultdict(set)
    for task, key in keys.items():
        if counts[key]:
            picks = []
            for index in range(catalog[task]["initialStateCount"]):
                rng = random.Random(7 + index)
                rng.random()
                picks.append(rng.randrange(counts[key]))
            selected[task] = picks
            indices[key].update(picks)
    offsets = Counter()
    replacements = {}
    for key, modified in language_rows(path):
        if key in indices:
            index = offsets[key]
            if index in indices[key]:
                replacements[key, index] = modified.replace("_", " ")
            offsets[key] += 1
    return {task: [replacements[keys[task], index] for index in picks] for task, picks in selected.items()}


def registration(args, image, catalog, source_files, base, suite, paraphrases):
    raw_profile = json.loads((HERE / "profiles/openvla-libero.json").read_text())
    suffix = f"-v{args.visual_level}" if args.visual_level else ""
    if args.language_level:
        suffix += f"-w{args.language_level}"
    safety = suite.startswith("safety_") and not args.task_success_only
    if args.task_success_only and suite.startswith("safety_"):
        suffix += "-task-success"
    name = "vla-arena-" + suite.replace("_", "-") + suffix + "-native"
    tasks = {task: row for task, row in catalog.items() if row["suite"] == suite}
    environment = {
        "kind": "vla-arena", "suite": suite, "safety": safety, "controlHz": 20, "environmentSeed": 7,
        "visualLevel": args.visual_level, "languageLevel": args.language_level,
        "visualProbe": {key: index < args.visual_level for index, key in enumerate(VISUAL_PROBES)},
        **({"languageReplacements": {task: paraphrases[task] for task in tasks if task in paraphrases}}
           if args.language_level else {}),
        "tasks": list(tasks), "catalog": tasks,
        "horizons": {task: row["horizon"] for task, row in tasks.items()},
        "initialStateCounts": {task: row["initialStateCount"] for task, row in tasks.items()},
        "initialStateDigests": {task: row["initialStateDigest"] for task, row in tasks.items()},
    }
    reference = {
        "id": name + "/1", "environment": environment,
        "parameters": {"replanSteps": 8, "settleSteps": 10, "renderSize": 256, "resizeSize": 224},
        "reference": {"evaluation": SOURCE, "files": source_files, "simulatorBase": base,
                      **({"languageRelease": LANGUAGE_RELEASE,
                          "languageDigest": "sha256:" + LANGUAGE_FILES[args.language_level]}
                         if args.language_level else {})},
        "benchmarkProfile": {**raw_profile["benchmarkProfile"], "id": "vla-arena-panda-raw/1"},
        "observationMap": raw_profile["observationMap"],
        "scoreName": "VLA-Arena safe task success" if safety else "VLA-Arena task success",
        "scoreUnit": "sample",
    }
    benchmark = {"name": name, "path": str(args.source.resolve()), "adapter": str(HERE / "adapter.py"),
                 "config": {"image": image, "python": "/usr/local/bin/python", "renderer": args.renderer,
                            "simGpus": "1" if args.renderer == "egl" else "0",
                            **({"simGpuMemGB": "4"} if args.renderer == "egl" else {}),
                            "reference": json.dumps(reference, separators=(",", ":")),
                            "profileDigest": digest(reference), "implementationDigest": implementation_digest()}}
    output = args.output_dir / name
    output.mkdir(parents=True, exist_ok=True)
    for filename, value in (("benchmark.json", benchmark), ("reference.json", reference)):
        (output / filename).write_text(json.dumps(value, indent=2) + "\n")
    print(f"{name}: {len(tasks)} tasks, {sum(environment['initialStateCounts'].values())} indexed initial states")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--base-image", default="orbit/robomimic:reference")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--build-tag")
    mode.add_argument("--benchmark-image")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--renderer", choices=("osmesa", "egl"), default="osmesa")
    parser.add_argument("--visual-level", choices=range(5), type=int, default=0)
    parser.add_argument("--language-level", choices=range(5), type=int, default=0)
    parser.add_argument("--language-dir", type=Path)
    parser.add_argument("--task-success-only", action="store_true")
    args = parser.parse_args()
    if args.benchmark_image and args.output_dir is None:
        parser.error("registration requires --output-dir")
    if args.language_level and args.language_dir is None:
        parser.error("W1-W4 require --language-dir with the pinned official replacements")
    check_source(args.source, SOURCE, {})
    subprocess.run(["git", "-C", str(args.source), "diff", "--quiet", "HEAD", "--"], check=True)
    base = image_id(args.base_image)
    record = manifest(base)
    if args.build_tag:
        build(args, record)
        return
    image = require_image(args.benchmark_image, record)
    catalog = get_catalog(image)
    source_files = {name: file_digest(args.source / name) for name in SOURCE_FILES}
    paraphrases = {}
    if args.language_level:
        path = args.language_dir / f"comprehensive_word_replacements_{args.language_level}.json"
        if file_digest(path) != "sha256:" + LANGUAGE_FILES[args.language_level]:
            raise ValueError("VLA-Arena language replacement file differs from the pinned release")
        paraphrases = freeze_replacements(path, catalog)
    for suite in SUITES:
        registration(args, image, catalog, source_files, base, suite, paraphrases)


if __name__ == "__main__":
    main()
