"""Regression checks against the pinned LIBERO-PRO source and native object registry."""

from contextlib import redirect_stdout
from io import StringIO
import json
from pathlib import Path
import tempfile
import unittest

if not Path("/opt/libero-pro/evaluation_config.yaml").is_file():
    raise unittest.SkipTest("requires the pinned LIBERO-PRO simulator image")

import yaml

from prepare_libero_pro import RECIPES, SOURCE, SUITES, get_object_dict, prepare, repair_configs


def goals(config):
    return {(suite, task, alternative): item["goal"]
            for suite, tasks in config.items()
            for task, alternatives in tasks.items()
            for alternative, item in alternatives.items()}


class LiberoProPreparationTests(unittest.TestCase):
    def test_repairs_the_missing_fixture_key_and_filters_object_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = repair_configs(Path(directory))
            objects = yaml.safe_load(Path(paths["object"]).read_text())

        registry = get_object_dict()
        for tasks in objects.values():
            for replacements in tasks.values():
                self.assertTrue(all(candidate in registry for choices in replacements.values()
                                    for candidate in choices))
        goal = objects["libero_goal"]
        self.assertEqual(goal["put_the_wine_bottle_on_top_of_the_cabinet"]["wooden_cabinet"],
                         ["yellow_cabinet", "white_cabinet"])
        self.assertNotIn("red_bowl", goal["put_the_cream_cheese_in_the_bowl"]["akita_black_bowl"])
        self.assertEqual(goal["put_the_wine_bottle_on_the_rack"]["wine_rack"], ["brown_rack"])
        mugs = objects["libero_10"][
            "LIVING_ROOM_SCENE5_put_the_white_mug_on_the_left_plate_and_put_the_yellow_and_white_mug_on_the_right_plate"]
        self.assertEqual(mugs["white_yellow_mug"], ["white_porcelain_mug"])
        self.assertEqual(mugs["porcelain_mug"], [])

    def test_repairs_only_the_three_unbalanced_task_goals(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = repair_configs(Path(directory))
            repaired = goals(yaml.safe_load(Path(paths["task"]).read_text()))
        original = goals(yaml.safe_load((SOURCE / "libero_ood/ood_task.yaml").read_text()))
        self.assertEqual(repaired.keys(), original.keys())
        changed = {key for key in original if original[key] != repaired[key]}
        self.assertEqual(changed, {key for key, goal in original.items()
                                   if goal.count(")") == goal.count("(") + 1})
        self.assertEqual(len(changed), 3)
        for key in changed:
            goal = original[key].strip()
            self.assertEqual(repaired[key], ("(" if goal.startswith("And ") else "(And ") + goal)
            self.assertEqual(repaired[key].count("("), repaired[key].count(")"))

    def test_prepared_catalog_is_repeatable_across_all_conditions(self):
        with tempfile.TemporaryDirectory() as directory:
            roots = [Path(directory) / name for name in ("first", "second")]
            with redirect_stdout(StringIO()):
                for root in roots:
                    prepare(root)
            first, second = [json.loads((root / "catalog.json").read_text()) for root in roots]
        self.assertEqual(first, second)
        self.assertEqual(set(first), {suite + "_" + mode for suite in SUITES for mode in RECIPES})
        self.assertTrue(all(len(tasks) == 10 for tasks in first.values()))
        self.assertTrue(all(row["instruction"] for tasks in first.values() for row in tasks.values()))


if __name__ == "__main__":
    unittest.main()
