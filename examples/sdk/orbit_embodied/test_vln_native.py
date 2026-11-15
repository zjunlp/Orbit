import copy
import json
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from orbit_embodied import digest, resolve_binding, run_episode, verify_episode
from orbit_embodied.chores import ACTIONS, native_goal, semantic_profile, start_pose, verify_chores
from orbit_embodied.binding import file_digest
from orbit_embodied.driver import StepResult
from orbit_embodied.evidence import seal
from orbit_embodied.hssd_ov import HORIZON, score_navigation, verify_hssd


class ChoresProtocolTests(unittest.TestCase):
    def test_declared_targets_for_every_family(self):
        row = {"synsets": ["cup.n.01"], "broad_synset_to_object_ids": {"cup.n.01": ["cup"]}}
        for kind in ("FetchType", "PickupType"):
            with self.subTest(kind=kind):
                self.assertTrue(native_goal({**row, "task_type": kind}, {"heldObjects": ["cup"]}))
                self.assertFalse(native_goal({**row, "task_type": kind}, {"heldObjects": ["plate"]}))
        self.assertTrue(native_goal({**row, "task_type": "ObjectNavOpenVocab"}, {"visibleTargets": ["cup"]}))
        with self.assertRaisesRegex(ValueError, "unexpected target"):
            native_goal({**row, "task_type": "ObjectNavOpenVocab"}, {"visibleTargets": ["plate"]})
        self.assertTrue(native_goal({"task_type": "RoomNav", "room_types": ["Kitchen"],
                                    "room_ids": {"Kitchen": ["room|1"]}}, {"room": "room|1"}))
        self.assertFalse(native_goal({"task_type": "SimpleExploreHouse", "num_rooms_in_house": 2},
                                     {"confirmedRooms": ["room|1", "room|1"], "roomCount": 2}))

    def test_episode_stop_seal_and_replay(self):
        task = "ObjectNavType:000"
        row = {"task_type": "ObjectNavType", "expert_length": 1, "natural_language_spec": "Find a cup.",
               "agent_starting_position": [0, 0.9, 0], "agent_y_rotation": 0, "synsets": ["cup.n.01"],
               "broad_synset_to_object_ids": {"cup.n.01": ["cup"]}}
        reference = {"environment": {"kind": "chores", "environmentSeed": 0, "horizons": {task: 600},
                                      "initialStateCounts": {task: 1}, "catalog": {task: row}},
                     "parameters": {"settleSteps": 0, "replanSteps": 1}}
        sample = {"taskId": task, "initialStateId": "0", "initialStateDigest": digest(row),
                  "environmentSeed": 0, "policySeed": 0}
        sample["sampleId"] = digest(sample)
        profile = semantic_profile()
        binding = resolve_binding(profile, {**profile, "observations": {"instruction": profile["observations"]["instruction"]}},
                                  {"instruction": "instruction"})

        class Benchmark:
            action_size, settle_steps, horizon = 1, 0, 600

            def reset(self, sample):
                return {"instruction": "Find a cup.", "navigation_pose": [0.0, 0.0, 0.0, 27.4],
                        "goalEvidence": None}

            def step(self, command):
                action = int(command[0])
                stopped = ACTIONS[action] == "end"
                observation = self.reset(None)
                if stopped:
                    observation["goalEvidence"] = {"visibleTargets": ["cup"]}
                return StepResult(observation, 0, stopped, stopped, native_action=[action], native_done=stopped)

            def state(self, observation):
                return observation

            def result(self):
                return {"success": True, "successWeightedLength": 0.5}

            def close(self):
                pass

        class Policy:
            replan_steps = 1

            def reset(self, sample):
                self.actions = iter((0, ACTIONS.index("end")))

            def act(self, observation):
                return np.array([[next(self.actions)]])

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "episode"
            result = run_episode(Benchmark(), Policy(), sample, binding, directory, "test",
                                 {"reference": reference})
            self.assertTrue(result["valid"])
            self.assertTrue(result["success"])
            self.assertEqual(verify_episode(directory, sample["sampleId"], "test")["native"]["successWeightedLength"], 0.5)
            log = directory / "actions.jsonl"
            controls = [json.loads(line) for line in log.read_text().splitlines()]
            initial = json.loads((directory / "initial-state.json").read_text())["state"]
            self.assertEqual(start_pose(row, 0), initial["navigation_pose"])
            with self.assertRaisesRegex(ValueError, "different start pose"):
                verify_chores(reference, sample, {**initial, "navigation_pose": [0.0, 0.0, 0.0, 0.0]},
                              controls, result)
            truncated = copy.deepcopy(controls[:1])
            truncated[0].update(terminated=True, nativeDone=True)
            with self.assertRaisesRegex(ValueError, "native rule"):
                verify_chores(reference, sample, initial, truncated, result)
            controls[-1]["state"]["goalEvidence"]["visibleTargets"] = ["plate"]
            log.write_text("".join(json.dumps(line) + "\n" for line in controls))
            seal(directory, result)
            with self.assertRaisesRegex(ValueError, "unexpected target"):
                verify_episode(directory, sample["sampleId"], "test")

    def test_room_visit_replays_confirmations_from_native_actions(self):
        task = "SimpleExploreHouse:000"
        rooms = ["room|0", "room|1"]
        row = {"task_type": "SimpleExploreHouse", "house_index": 7, "num_rooms_in_house": 2,
               "expert_length": 10, "natural_language_spec": "Visit every room.",
               "agent_starting_position": [0, 0.9, 0], "agent_y_rotation": 0}
        environment = {"kind": "chores", "environmentSeed": 0, "horizons": {task: 1000},
                       "initialStateCounts": {task: 1}, "catalog": {task: row}}
        legacy = {"environment": environment}
        reference = {"environment": {**environment, "roomVisitRooms": {"7": rooms}}}
        sample = {"taskId": task, "initialStateId": "0", "initialStateDigest": digest(row),
                  "environmentSeed": 0, "policySeed": 0}
        initial = {"instruction": row["natural_language_spec"], "navigation_pose": start_pose(row, 0),
                   "goalEvidence": None, "roomVisitRoom": None}

        def step(name, room):
            action = [ACTIONS.index(name)]
            stopped = name == "end"
            state = {**initial, "roomVisitRoom": room}
            if stopped:
                state["goalEvidence"] = {"confirmedRooms": rooms.copy(), "roomCount": 2}
            return {"action": action, "nativeAction": action, "state": state, "reward": 0,
                    "nativeSuccess": stopped, "terminated": stopped, "nativeDone": stopped}

        controls = [step("sub_done", rooms[0]), step("sub_done", rooms[0]), step("m", rooms[0]),
                    step("sub_done", rooms[1]), step("end", rooms[1])]
        result = {"native": {"success": True, "successWeightedLength": 1.0}}
        verify_chores(reference, sample, initial, controls, result)
        for invalid in ([controls[-1]], [*controls[:3], controls[-1]]):
            # A repeated confirmation of the same room does not confirm another room.
            with self.assertRaisesRegex(ValueError, "confirmations differ"):
                verify_chores(reference, sample, initial, invalid, result)
        changed = copy.deepcopy(controls)
        changed[3]["state"]["roomVisitRoom"] = "room|unknown"
        with self.assertRaisesRegex(ValueError, "invalid room"):
            verify_chores(reference, sample, initial, changed, result)
        changed[3]["state"].pop("roomVisitRoom")
        with self.assertRaisesRegex(ValueError, "invalid room"):
            verify_chores(reference, sample, initial, changed, result)

        for state in [initial, *(step["state"] for step in controls)]:
            state.pop("roomVisitRoom")
        verify_chores(legacy, sample, initial, controls, result)
        with self.assertRaisesRegex(ValueError, "more rooms than sub_done"):
            verify_chores(legacy, sample, initial, controls[-1:], result)


class HssdProtocolTests(unittest.TestCase):
    def test_native_stop_radius_and_supplemental_spl(self):
        self.assertEqual(score_navigation(0.5, 0.24, 1.0, True)["spl"], 0.5)
        self.assertFalse(score_navigation(0.5, 0.25, 1.0, True)["success"])
        self.assertFalse(score_navigation(0.5, 0.0, 1.0, False)["success"])
        self.assertFalse(score_navigation(0.5, None, 0.0, True)["success"])

    def test_cpu_replay_rejects_changed_viewpoint_and_wrong_control(self):
        from types import SimpleNamespace

        task = "example:1"
        initial = {"agent_position": [0.0, 0.0, 0.0], "rotation": [0, 0, 0, 1], "instruction": "Find the chair."}
        slid_position = [-0.0625, 0.0, -0.125]
        viewpoints = [slid_position]
        row = {"start": initial["agent_position"], "rotation": initial["rotation"], "category": "chair",
               "viewpointsDigest": digest(viewpoints)}
        reference = {"environment": {"kind": "hssd-ov", "environmentSeed": 42, "horizon": HORIZON,
                                     "initialStateCounts": {task: 1}, "catalog": {task: row}}}
        sample = {"taskId": task, "initialStateId": "0", "environmentSeed": 42}
        left = [0, math.sin(math.pi / 12), 0, math.cos(math.pi / 12)]
        identity = [0, 0, 0, -1]

        def step(action, position, rotation):
            stopped = action == 0
            return {"action": [action], "nativeAction": [action], "reward": 0,
                    "state": {**initial, "agent_position": position, "rotation": rotation},
                    "nativeSuccess": stopped, "nativeDone": stopped, "terminated": stopped}

        controls = [step(2, initial["agent_position"], left), step(1, slid_position, left),
                    step(3, slid_position, identity), step(0, slid_position, identity)]
        length = math.dist(initial["agent_position"], slid_position)
        result = {"native": score_navigation(length, 0.0, length, True)}

        def try_step(start, target):
            np.testing.assert_allclose(start, initial["agent_position"])
            np.testing.assert_allclose(target, [-0.125, 0.0, -math.sqrt(3) / 8], atol=1e-7)
            return np.asarray(slid_position)

        pathfinder = SimpleNamespace(load_nav_mesh=lambda path: True, try_step=try_step)

        def distance(pathfinder, position, targets):
            return math.dist(position, targets[0])

        with tempfile.TemporaryDirectory() as temporary, \
                patch.dict("sys.modules", {"habitat_sim": SimpleNamespace(PathFinder=lambda: pathfinder)}), \
                patch("orbit_embodied.hssd_ov.distance_to_target", side_effect=distance):
            directory = Path(temporary)
            goals = directory / "goal-viewpoints.json"
            goals.write_text(json.dumps(viewpoints))
            navmesh = directory / "navigation.navmesh"
            navmesh.write_bytes(b"fixture mesh")
            row["navmeshDigest"] = file_digest(navmesh)
            sample["initialStateDigest"] = digest(row)
            verify_hssd(reference, sample, initial, controls, result, directory)
            for index, invalid in (
                (0, step(3, initial["agent_position"], left)),
                (1, step(1, [0.0, 0.0, -0.125], left)),
                (1, step(1, slid_position, identity)),
                (3, step(0, slid_position, left)),
            ):
                with self.subTest(index=index, invalid=invalid), self.assertRaisesRegex(ValueError, "motion contradicts"):
                    changed = controls.copy()
                    changed[index] = invalid
                    verify_hssd(reference, sample, initial, changed, result, directory)
            with self.assertRaisesRegex(ValueError, "invalid HSSD-OV native rotation"):
                verify_hssd(reference, sample, initial, [step(2, initial["agent_position"], [0, 0, 0, 0]),
                                                       *controls[1:]], result, directory)
            navmesh.write_bytes(b"changed mesh")
            with self.assertRaisesRegex(ValueError, "navmesh differs"):
                verify_hssd(reference, sample, initial, controls, result, directory)
            goals.write_text(json.dumps([[0.0, 0.0, 0.0]]))
            with self.assertRaisesRegex(ValueError, "viewpoints differ"):
                verify_hssd(reference, sample, initial, controls, result, directory)
