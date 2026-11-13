"""Compare deterministic I/O helpers with pinned official OFT functions, on CPU."""

import argparse
import ast
import json
import math
from pathlib import Path
from types import SimpleNamespace


def helpers(path, names, namespace):
    tree = ast.parse(path.read_text())
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    if {node.name for node in functions} != set(names):
        raise ValueError("official helper definitions changed")
    future = ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0)
    module = ast.fix_missing_locations(ast.Module(body=[future, *functions], type_ignores=[]))
    exec(compile(module, str(path), "exec"), namespace)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path("/opt/openvla"))
    args = parser.parse_args()
    import numpy as np
    import tensorflow as tf
    tf.config.set_visible_devices([], "GPU")
    from experiments.robot import openvla_utils as official
    from orbit_embodied.openvla import libero_inputs, native_actions
    namespace = {"np": np, "math": math, "resize_image_for_policy": official.resize_image_for_policy}
    robot = args.source / "experiments/robot"
    helpers(robot / "libero/libero_utils.py", ["get_libero_image", "get_libero_wrist_image", "quat2axisangle"], namespace)
    helpers(robot / "robot_utils.py", ["normalize_gripper_action", "invert_gripper_action"], namespace)
    helpers(robot / "libero/run_libero_eval.py", ["prepare_observation", "process_action"], namespace)
    random = np.random.default_rng(7)
    cfg = SimpleNamespace(center_crop=True)
    for quaternion in ([0., 0., 0., 1.], [0., 0., math.sqrt(.5), math.sqrt(.5)], [0., 0., 0., 1.000001]):
        raw = {"front_rgb": random.integers(0, 256, (256, 256, 3), dtype=np.uint8),
               "wrist_rgb": random.integers(0, 256, (256, 256, 3), dtype=np.uint8),
               "eef_position": random.normal(size=3), "eef_quaternion": np.array(quaternion),
               "gripper_position": random.normal(size=2), "instruction": "put the bowl on the plate"}
        native = {"agentview_image": raw["front_rgb"], "robot0_eye_in_hand_image": raw["wrist_rgb"],
                  "robot0_eef_pos": raw["eef_position"], "robot0_eef_quat": raw["eef_quaternion"].copy(),
                  "robot0_gripper_qpos": raw["gripper_position"]}
        expected, _ = namespace["prepare_observation"](native, 224)
        actual = libero_inputs(raw)
        np.testing.assert_array_equal(actual["state"], expected["state"])
        for name in ("full_image", "wrist_image"):
            expected_image = official.prepare_images_for_vla([expected[name]], cfg)[0]
            actual_image = official.prepare_images_for_vla([actual[name]], cfg)[0]
            np.testing.assert_array_equal(np.asarray(actual_image), np.asarray(expected_image))
    for dtype in (np.float32, np.float64):
        actions = random.uniform(-1, 1, (8, 7)).astype(dtype)
        actions[:, -1] = [0, .2, .49, .5, .51, .8, 1, 2]
        expected = np.asarray([namespace["process_action"](action, "openvla") for action in actions])
        np.testing.assert_array_equal(native_actions(actions), expected)
    print(json.dumps({"officialImageAndStateHelpers": "passed", "officialActionConversion": "passed",
                      "checkpointInference": "not_run", "fullRolloutParity": "not_run"}))


if __name__ == "__main__":
    main()
