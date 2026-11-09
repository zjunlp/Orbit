"""LIBERO-Plus task identity and native reset files for the four perturbation suites."""

import ast
import json
import re
from pathlib import Path

from .binding import file_digest


SUITE_COUNTS = {"libero_spatial": 2402, "libero_object": 2518, "libero_goal": 2591, "libero_10": 2519}
SOURCE_FILES = (
    "libero/libero/benchmark/__init__.py",
    "libero/libero/benchmark/libero_suite_task_map.py",
    "libero/libero/benchmark/task_classification.json",
    "libero/libero/envs/env_wrapper.py",
)
NATIVE_ROOT = "/opt/libero-plus/libero/libero"
PERTURBATIONS = ("Objects Layout", "Camera Viewpoints", "Robot Initial States", "Language Instructions",
                 "Light Conditions", "Background Textures", "Sensor Noise")


def metric_name(category):
    if category not in PERTURBATIONS:
        raise ValueError("unknown LIBERO-Plus perturbation: " + category)
    return "success_" + category.lower().replace(" ", "_")


def classifications(root, suite):
    return json.loads((root / "benchmark/task_classification.json").read_text())[suite]


def initial_state_path(root, suite, name):
    # Mirrors the pinned native Benchmark.get_task_init_states resolution.
    if "_language_" in name:
        name = name.split("_language_")[0]
    elif "_view_" in name:
        name = name.split("_view_")[0]
    elif "_add_" in name or "_level" in name:
        return root / "libero_newobj" / suite / (name + ".pruned_init")
    elif "_light_" in name:
        name = name.split("_light_")[0]
    elif "_tb_" in name:
        name = re.sub(r"_tb_\d+", "", name)
    elif "_table_" in name:
        name = re.sub(r"_table_\d+", "", name)
    else:
        raise ValueError("unexpected LIBERO-Plus initial state recipe: " + name)
    return root / suite / (name + ".pruned_init")


def catalog(root, suite):
    root = root / "libero/libero"
    tree = ast.parse((root / "benchmark/libero_suite_task_map.py").read_text())
    assignment = next(node for node in tree.body if isinstance(node, ast.Assign)
                      and any(isinstance(t, ast.Name) and t.id == "libero_task_map" for t in node.targets))
    names = ast.literal_eval(assignment.value)[suite]
    rows = classifications(root, suite)
    if (len(names) != SUITE_COUNTS[suite] or len(rows) != len(names) or len(set(names)) != len(names)
            or {row["category"] for row in rows} != set(PERTURBATIONS)
            or any(row["id"] != i + 1 or row["name"] != name for i, (name, row) in enumerate(zip(names, rows)))):
        raise ValueError("LIBERO-Plus suite and published perturbation classification differ")
    hashes = {}
    result = []
    for index, (name, row) in enumerate(zip(names, rows)):
        bddl = root / "bddl_files" / suite / (name.split("_view_")[0] + ".bddl")
        initial = initial_state_path(root / "init_files", suite, name)
        missing = [str(path.relative_to(root)) for path in (bddl, initial) if not path.is_file()]
        tags = {"suite": suite, "taskIndex": str(index), "initialStateCount": "1",
                "perturbation": row["category"], "difficulty": str(row["difficulty_level"]),
                "releaseId": str(row["id"])}
        if not missing:
            if initial not in hashes:
                hashes[initial] = file_digest(initial)
            tags["initialStateDigest"] = hashes[initial]
        result.append({"id": suite + ":" + name, "title": name.replace("_", " "), "tags": tags,
                       "supported": not missing, "reason": "Missing " + ", ".join(missing) if missing else None})
    return result
