"""Compile the pinned LIBERO-PRO leaderboard BDDL with the upstream perturbators."""

import hashlib
import json
from pathlib import Path
import random
import sys
import tempfile

import yaml
from bddl.parsing import scan_tokens
from perturbation import BDDLCombinedPerturbator, PerturbFlags
from libero.libero.benchmark.libero_suite_task_map import libero_task_map
from libero.libero.envs.objects import get_object_dict


SUITES = ("libero_spatial", "libero_object", "libero_goal", "libero_10")
RECIPES = {"object": "object", "swap": "swap", "lan": "language", "task": "task", "env": "environment"}
SOURCE = Path("/opt/libero-pro")
SEED = 0


def repair_configs(temporary):
    configs = yaml.safe_load((SOURCE / "evaluation_config.yaml").read_text())["ood_task_configs"]
    paths = {key: SOURCE / value for key, value in configs.items()}
    # The released YAML omits the fixture name in one object replacement.
    original = paths["object"].read_text()
    missing_key = "    :\n      - yellow_cabinet\n      - white_cabinet"
    if original.count(missing_key) != 1:
        raise ValueError("unexpected LIBERO-PRO object YAML")
    objects = yaml.safe_load(original.replace(missing_key, "    wooden_cabinet:" + missing_key[5:]))
    registry = get_object_dict()
    for tasks in objects.values():
        for replacements in tasks.values():
            reserved = set()
            for name, candidates in replacements.items():
                # The stand lacks the top region referenced by the wine rack BDDL.
                available = [candidate for candidate in candidates if candidate in registry and candidate not in reserved
                             and (name, candidate) != ("wine_rack", "wine_rack_stand")]
                replacements[name] = available
                # Two singleton replacements to the same type would alias object instance IDs.
                if len(available) == 1:
                    reserved.add(available[0])
    paths["object"] = temporary / "object.yaml"
    paths["object"].write_text(yaml.safe_dump(objects, sort_keys=False))
    # Three released alternatives omit the opening goal conjunction.
    task = yaml.safe_load(paths["task"].read_text())
    for tasks in task.values():
        for alternatives in tasks.values():
            for item in alternatives.values():
                goal = item["goal"].strip()
                if goal.count(")") == goal.count("(") + 1:
                    item["goal"] = ("(" if goal.startswith("And ") else "(And ") + goal
    paths["task"] = temporary / "task.yaml"
    paths["task"].write_text(yaml.safe_dump(task, sort_keys=False))
    return {name: str(path) for name, path in paths.items()}


def prepare(output):
    catalog = {}
    with tempfile.TemporaryDirectory() as temporary:
        perturbator = BDDLCombinedPerturbator(repair_configs(Path(temporary)))
        for suite in SUITES:
            for mode, flag in RECIPES.items():
                scope = suite + "_" + mode
                directory = output / scope
                directory.mkdir(parents=True, exist_ok=True)
                entries = catalog[scope] = {}
                for name in libero_task_map[scope]:
                    original = SOURCE / "libero/libero/bddl_files" / suite / (name + ".bddl")
                    random.seed(SEED)
                    changed = perturbator.perturb_content(original.read_text(), suite, name,
                                                          PerturbFlags(**{"use_" + flag: True}), seed=SEED)
                    bddl = directory / original.name
                    bddl.write_text(changed)
                    before = scan_tokens(filename=str(original))
                    after = scan_tokens(filename=str(bddl))
                    language = next(group[1:] for group in after[1:] if group[0] == ":language")
                    entries[name] = {"instruction": " ".join(language),
                                     "digest": "sha256:" + hashlib.sha256(bddl.read_bytes()).hexdigest(),
                                     "applied": before != after}
    (output / "catalog.json").write_text(json.dumps(catalog, indent=2) + "\n")


if __name__ == "__main__":
    prepare(Path(sys.argv[1]))
