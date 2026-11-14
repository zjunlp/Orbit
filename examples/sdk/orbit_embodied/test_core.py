"""Synthetic endpoint checks; these do not establish real policy or simulator fidelity."""

import copy
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

from orbit_embodied import EpisodeFailure, StepResult, digest, resolve_binding, run_episode, verify_episode
from orbit_embodied.evidence import seal, verify_manipulation_stopping, write_json
from orbit_embodied.driver import SampleRejected
from orbit_embodied.libero_mem import verify_mem_episode
from orbit_embodied.openpi import quaternion_to_axis_angle


class SyntheticBenchmark:
    horizon = 7
    action_size = 7

    def __init__(self, success_at=None, fail_at=None):
        self.success_at, self.fail_at = success_at, fail_at
        self.count = 0
        self.closed = False

    def reset(self, sample):
        return {"state": np.zeros(3)}

    def state(self, observation):
        return {"state": observation["state"].tolist()}

    def step(self, action):
        if self.count == self.fail_at:
            raise RuntimeError("synthetic step failure")
        self.count += 1
        success = self.count == self.success_at
        return StepResult({"state": np.ones(3) * self.count}, float(success), success, success)

    def result(self):
        return {"success": self.count == self.success_at}

    def close(self):
        self.closed = True


class SyntheticPolicy:
    replan_steps = 5

    def __init__(self, invalid=False):
        self.calls = 0
        self.closed = False
        self.invalid = invalid

    def reset(self, sample):
        pass

    def act(self, observation):
        self.calls += 1
        return np.full((6, 7), np.nan if self.invalid else self.calls * 0.1)

    def close(self):
        self.closed = True


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.output = Path(self.temporary.name) / "episode"
        fields = {"state": {"semantic": "position", "dtype": "float64", "shape": [3], "frame": "world", "unit": "metre"}}
        self.benchmark_profile = {"id": "synthetic-benchmark", "observations": fields,
                                  "action": {"semantic": "synthetic-control", "controller": "synthetic", "shape": [7],
                                             "frame": "world", "unit": "normalized", "rotation": "axis-angle", "gripper": "native"}}
        self.policy_profile = {**self.benchmark_profile, "id": "synthetic-policy"}
        self.binding = resolve_binding(self.benchmark_profile, self.policy_profile, {"state": "state"})
        content = {"taskId": "synthetic:task", "benchmarkProfile": "synthetic-reference",
                   "initialStateId": "0", "initialStateDigest": "sha256:" + "a" * 64,
                   "environmentSeed": 7, "policySeed": 0, "repetition": 0}
        self.sample = {**content, "sampleId": digest(content)}

    def tearDown(self):
        self.temporary.cleanup()

    def run_sample(self, benchmark, policy, identity=None):
        return run_episode(benchmark, policy, self.sample, self.binding, self.output,
                           "synthetic-trial.attempt", identity or {"fixture": True})

    def verify(self):
        return verify_episode(self.output, self.sample["sampleId"], "synthetic-trial.attempt")

    def test_libero_mem_partial_progress_is_scored_without_terminating(self):
        first = ["and", ["in", "cream_cheese_1", "basket_1_contain_region"]]
        empty_basket = ["and", ["on", "basket_2", "kitchen_table_the_center"]]
        reference = {"environment": {"catalog": {"task": {
            "subgoals": 2, "instruction": "ordered task", "goalBranches": [[first, empty_basket]],
        }}}}
        sample = {"taskId": "task"}
        initial = {"instruction": "ordered task", "satisfiedSubgoals": [], "satisfiedPredicates": [], "overshot": False}
        partial = {**initial, "satisfiedSubgoals": ["first goal"], "satisfiedPredicates": [first]}
        controls = [{"state": partial, "nativeSuccess": False, "terminated": False}]
        result = {"native": {"completedSubgoals": 1, "totalSubgoals": 2,
                             "satisfiedSubgoals": ["first goal"], "satisfiedPredicates": [first], "overshot": False}}
        verify_mem_episode(reference, sample, initial, controls, result)
        with self.assertRaisesRegex(ValueError, "native success or stopping"):
            verify_mem_episode(reference, sample, initial, [{**controls[0], "terminated": True}], result)
        with self.assertRaisesRegex(ValueError, "native score"):
            verify_mem_episode(reference, sample, initial, controls,
                               {"native": {**result["native"], "totalSubgoals": 1}})

    def test_libero_mem_distinguishes_branches_with_the_same_display_labels(self):
        in_basket = [["and", ["in", "cream_cheese_1", f"basket_{i}_contain_region"]] for i in (1, 2)]
        on_table = [["and", ["on", f"basket_{i}", "kitchen_table_the_center"]] for i in (1, 2)]
        branches = [[in_basket[0], on_table[1]], [in_basket[1], on_table[0]]]
        reference = {"environment": {"catalog": {"task": {
            "subgoals": 2, "instruction": "move the empty basket", "goalBranches": branches,
        }}}}
        sample = {"taskId": "task"}
        initial = {"instruction": "move the empty basket", "satisfiedSubgoals": [],
                   "satisfiedPredicates": [], "overshot": False}
        for index, branch in enumerate(branches):
            with self.subTest(branch=index):
                partial = {**initial, "satisfiedSubgoals": ["fill basket"], "satisfiedPredicates": branch[:1]}
                completed = {**partial, "satisfiedSubgoals": ["fill basket", "move basket"],
                             "satisfiedPredicates": branch}
                controls = [{"state": partial, "nativeSuccess": False, "terminated": False},
                            {"state": completed, "nativeSuccess": True, "terminated": True}]
                result = {"native": {**completed, "completedSubgoals": 2, "totalSubgoals": 2}}
                verify_mem_episode(reference, sample, initial, controls, result)
                wrong_branch = [branch[0], on_table[index]]
                controls[-1]["state"] = {**completed, "satisfiedPredicates": wrong_branch}
                result["native"]["satisfiedPredicates"] = wrong_branch
                with self.assertRaisesRegex(ValueError, "ordered subgoal evidence"):
                    verify_mem_episode(reference, sample, initial, controls, result)

    def test_cliport_evidence_preserves_partial_reward_at_native_horizon(self):
        from orbit_embodied.cliport import CLIPortBenchmark, verify_cliport

        task = self.sample["taskId"]
        sample = {**self.sample, "initialStateId": "1", "environmentSeed": 10001}
        reference = {"environment": {"kind": "cliport", "primitive": "pick-place",
                                     "environmentSeed": 10001, "tasks": [task],
                                     "initialStateCounts": {task: 2},
                                     "testEpisodes": {task: [{"seed": 10001, "horizon": 5},
                                                             {"seed": 10007, "horizon": 2}]}},
                     "parameters": {"controlHz": 5}}
        self.assertEqual(CLIPortBenchmark(reference, {**sample, "initialStateId": "0"}).horizon, 5)
        self.assertEqual(CLIPortBenchmark(reference, sample).horizon, 2)
        action = [0.0] * 14
        controls = [
            {"reward": 0.25, "action": action, "nativeAction": action, "nativeDone": False,
             "nativeSuccess": False, "terminated": step == 2,
             "state": {"instruction": str(step), "totalReward": step * 0.25}}
            for step in (1, 2)
        ]
        native = {"source": "CLIPort test mean reward", "task": task, "seed": 10007,
                  "primitive": "pick-place", "success": False, "totalReward": 0.5}
        verify_cliport(reference, sample, controls, {"native": native})
        for altered in ({"totalReward": 0.0}, {"seed": 10003}):
            with self.subTest(altered=altered), self.assertRaisesRegex(ValueError, "cumulative reward"):
                verify_cliport(reference, sample, controls, {"native": {**native, **altered}})
        with self.assertRaisesRegex(ValueError, "stopping rules"):
            verify_cliport(reference, sample, [{**controls[0], "nativeDone": True}, controls[1]], {"native": native})
        with self.assertRaisesRegex(ValueError, "exceed the frozen sample horizon"):
            verify_cliport(reference, sample, [*controls, controls[-1]], {"native": native})
        legacy_reference = copy.deepcopy(reference)
        del legacy_reference["environment"]["testEpisodes"]
        with self.assertRaisesRegex(ValueError, "regenerate the CLIPort seed catalogue"):
            CLIPortBenchmark(legacy_reference, sample)

    def test_cliport_push_binding_and_native_command(self):
        from orbit_embodied.cliport import profile, verify_cliport

        benchmark = profile("native", "push")
        observation_map = {key: key for key in benchmark["observations"]}
        resolve_binding(benchmark, profile("policy", "push"), observation_map)
        with self.assertRaisesRegex(ValueError, "action semantics differ"):
            resolve_binding(benchmark, profile("policy", "pick-place"), observation_map)

        task = "separating-piles-seen-colors"
        sample = {**self.sample, "taskId": task, "initialStateId": "0", "environmentSeed": 10001}
        reference = {"environment": {"kind": "cliport", "primitive": "push", "environmentSeed": 10001,
                                     "initialStateCounts": {task: 1},
                                     "testEpisodes": {task: [{"seed": 10001, "horizon": 1}]}}}
        action = [0.25, -0.1, 0.5, 0.1]
        native_action = [0.25, -0.1, 0, 0, 0, 0, 1, 0.5, 0.1, 0, 0, 0, 0, 1]
        control = {"action": action, "nativeAction": native_action, "nativeDone": False,
                   "terminated": True, "nativeSuccess": False, "reward": 0.25,
                   "state": {"instruction": "push the pile", "totalReward": 0.25}}
        result = {"native": {"source": "CLIPort test mean reward", "task": task, "seed": 10001,
                             "primitive": "push", "success": False, "totalReward": 0.25}}
        verify_cliport(reference, sample, [control], result)
        with self.assertRaisesRegex(ValueError, "control evidence differs"):
            verify_cliport(reference, sample, [{**control, "nativeAction": action}], result)

    def test_bigym2_fall_overrides_task_success(self):
        from orbit_embodied.bigym2 import verify_bigym2

        task = self.sample["taskId"]
        sample = {**self.sample, "initialStateId": "99", "environmentSeed": 620000}
        reference = {"environment": {"kind": "bigym2", "environmentSeed": 620000,
                                     "horizons": {task: 4}, "taskTitles": {task: "Open the drawer."},
                                     "initialStateCounts": {task: 100}}}
        action = [0.0] * 20
        controls = [
            {"action": action, "nativeAction": action, "nativeDone": step == 2,
             "terminated": step == 2, "nativeSuccess": False,
             "state": {"instruction": "Open the drawer.", "taskSucceeded": step == 2,
                       "fell": True, "truncation": None}} for step in (1, 2)
        ]
        native = {"source": "BiGym 2.0 protocol v1", "task": task, "seed": 620099, "termination": "fell",
                  "success": False, "taskSucceeded": True, "fell": True, "truncation": None}
        verify_bigym2(reference, sample, controls, {"native": native})
        with self.assertRaisesRegex(ValueError, "success or stopping"):
            verify_bigym2(reference, sample, [controls[0], {**controls[1], "nativeSuccess": True}], {"native": native})

    def test_calvin_partial_sequence_replans_and_verifies_its_progress(self):
        tasks = ["one", "two", "three", "four", "five"]

        class Sequence(SyntheticBenchmark):
            horizon = 10
            settle_steps = 0

            def step(self, action):
                self.count += 1
                completed = self.count <= 2
                return StepResult({"state": np.zeros(3)}, float(completed), self.count == 4,
                                  False, replan=completed)

            def state(self, observation):
                return {"completedSubtasks": min(self.count, 2)}

            def result(self):
                return {"success": False, "sequence": tasks, "completedSubtasks": 2}

        self.sample["environmentSeed"] = 0
        self.sample["sampleId"] = digest({key: value for key, value in self.sample.items() if key != "sampleId"})
        reference = {"environment": {"kind": "calvin", "horizon": 10,
                                     "catalog": {"sequences": [[0, tasks]]}},
                     "parameters": {"settleSteps": 0, "replanSteps": 5, "subtaskSteps": 2}}
        result = self.run_sample(Sequence(), SyntheticPolicy(), {"reference": reference})
        rows = [json.loads(line) for line in (self.output / "actions.jsonl").read_text().splitlines()]
        self.assertEqual([row["chunkIndex"] for row in rows], [0, 0, 0, 1])
        self.assertEqual(self.verify()["native"]["completedSubtasks"], 2)
        result["native"]["completedSubtasks"] = 3
        seal(self.output, result)
        with self.assertRaisesRegex(ValueError, "recorded subtask completions"):
            self.verify()

    def test_robodojo_partial_score_is_verified_against_native_steps_and_layout(self):
        layout = {"id": 0, "file": "Eval_Layout/synthetic/task_3.json", "digest": "sha256:" + "b" * 64}
        identity = {"evalSeed": 0, **layout}
        reference = {"environment": {"kind": "robodojo", "tasks": [self.sample["taskId"]], "horizon": 7,
                                    "layouts": {self.sample["taskId"]: {"0": [layout]}}},
                     "parameters": {"settleSteps": 0, "replanSteps": 5, "successRule": "last"}}
        self.sample["environmentSeed"] = 0
        self.sample["sampleId"] = digest({key: value for key, value in self.sample.items() if key != "sampleId"})

        class Partial(SyntheticBenchmark):
            def step(self, action):
                result = super().step(action)
                result.terminated = self.count == self.horizon
                return result

            def state(self, observation):
                return {"layout": identity, "nativeStepCount": self.count, "nativeEnded": self.count == self.horizon,
                        "nativeSuccess": False, "nativeUnstable": False, "processScore": 40.0}

            def result(self):
                return {"success": False, "score": 0.4, **self.state(None)}

        result = self.run_sample(Partial(), SyntheticPolicy(), {"reference": reference})
        self.assertTrue(self.verify()["valid"])
        self.assertEqual(self.verify()["native"]["score"], 0.4)
        result["native"]["score"] = 1.0
        seal(self.output, result)
        with self.assertRaisesRegex(ValueError, "score differs"):
            self.verify()
        result["native"]["score"] = 0.4
        result["native"]["processScore"] = 100.0
        seal(self.output, result)
        with self.assertRaisesRegex(ValueError, "recorded native state"):
            self.verify()

    def test_libero_pro_rejects_changed_bddl_identity_after_resealing(self):
        instruction = "place the object in the drawer"
        reset_digest = digest([0.1, 0.2])

        class PerturbedTask(SyntheticBenchmark):
            def state(self, observation):
                return {**super().state(observation), "instruction": instruction,
                        "resetStateDigest": reset_digest}

            def result(self):
                return {**super().result(), "instruction": instruction, "perturbation": "task"}

        reference = {"environment": {"kind": "libero-pro", "perturbation": "task",
                                     "taskTitles": {self.sample["taskId"]: instruction}},
                     "parameters": {"settleSteps": 0, "replanSteps": 5}}
        result = self.run_sample(PerturbedTask(success_at=2), SyntheticPolicy(), {"reference": reference})
        self.assertEqual(self.verify()["native"]["instruction"], instruction)
        initial_file = self.output / "initial-state.json"
        actions_file = self.output / "actions.jsonl"
        initial = json.loads(initial_file.read_text())
        actions = [json.loads(line) for line in actions_file.read_text().splitlines()]
        for field, value in (("instruction", "another task"), ("perturbation", "lan")):
            with self.subTest(native=field):
                seal(self.output, {**result, "native": {**result["native"], field: value}})
                with self.assertRaisesRegex(ValueError, "differs from the frozen BDDL"):
                    self.verify()

        for field, value, message in (
            ("instruction", "another task", "differs from the frozen BDDL"),
            ("resetStateDigest", "", "constructor state differs"),
        ):
            with self.subTest(initial=field):
                write_json(initial_file, {**initial, "state": {**initial["state"], field: value}})
                seal(self.output, result)
                with self.assertRaisesRegex(ValueError, message):
                    self.verify()
        write_json(initial_file, initial)

        for field, value, message in (
            ("instruction", "another task", "differs from the frozen BDDL"),
            ("resetStateDigest", digest([0.2, 0.1]), "constructor state differs"),
        ):
            with self.subTest(control=field):
                changed = copy.deepcopy(actions)
                changed[-1]["state"][field] = value
                actions_file.write_text("".join(json.dumps(row) + "\n" for row in changed))
                seal(self.output, result)
                with self.assertRaisesRegex(ValueError, message):
                    self.verify()

    def test_native_instability_during_control_remains_an_explicit_rejected_sample(self):
        class Unstable(SyntheticBenchmark):
            def step(self, action):
                if self.count == 2:
                    raise SampleRejected("synthetic native instability after control")
                return super().step(action)

        result = self.run_sample(Unstable(), SyntheticPolicy())
        self.assertEqual(result["failure"], "sample_rejected")
        self.assertFalse(result["valid"])
        self.assertEqual(self.verify()["steps"], 2)

    def test_robocasa_v02_rejects_changed_native_commands_and_stopping(self):
        class FixedBase(SyntheticBenchmark):
            def step(self, action):
                result = super().step(action)
                result.native_action = action.tolist() + [0] * 5
                result.terminated |= self.count == self.horizon
                return result

        reference = {"environment": {"kind": "robocasa-v02", "horizon": 7},
                     "parameters": {"settleSteps": 0, "replanSteps": 5}}
        for success_at in (None, 3):
            self.output = Path(self.temporary.name) / ("episode-" + str(success_at))
            result = self.run_sample(FixedBase(success_at=success_at), SyntheticPolicy(), {"reference": reference})
            self.assertEqual(self.verify()["success"], success_at is not None)
            path = self.output / "actions.jsonl"
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            for changes, message in (
                ({"nativeAction": rows[0]["nativeAction"][:-1] + [1]}, "fixed-base conversion"),
                ({"nativeAction": None}, "fixed-base conversion"),
                ({"terminated": True}, "first native success or the task horizon"),
                ({"nativeSuccess": True, "reward": 1}, "first native success or the task horizon"),
            ):
                with self.subTest(success_at=success_at, changes=changes):
                    altered = [{**rows[0], **changes}, *rows[1:]]
                    if changes == {"nativeAction": None}:
                        del altered[0]["nativeAction"]
                    path.write_text("".join(json.dumps(row) + "\n" for row in altered))
                    seal(self.output, result)
                    with self.assertRaisesRegex(ValueError, message):
                        self.verify()
            if success_at is None:
                early = [*rows[:2], {**rows[2], "terminated": True}]
                path.write_text("".join(json.dumps(row) + "\n" for row in early))
                seal(self.output, {**result, "steps": len(early)})
                with self.assertRaisesRegex(ValueError, "first native success or the task horizon"):
                    self.verify()

    def test_manipulation_evidence_distinguishes_native_done_from_success(self):
        terminal = {"nativeDone": False, "nativeSuccess": True, "terminated": True}
        verify_manipulation_stopping("robomimic", [terminal], 5)
        with self.assertRaisesRegex(ValueError, "native termination protocol"):
            verify_manipulation_stopping("robomimic", [{**terminal, "nativeSuccess": False}], 5)

        action = [0.4, 0.1, 0, 0, 0, 1, 0.5, 0.2, 0, 0, 0, 1]
        vima = {**terminal, "nativeDone": True, "action": action,
                "nativeAction": np.asarray(action, dtype=np.float32).tolist()}
        verify_manipulation_stopping("vima-bench", [vima], 5)
        with self.assertRaisesRegex(ValueError, "native termination protocol"):
            verify_manipulation_stopping("vima-bench", [{**vima, "nativeDone": False}], 5)
        with self.assertRaisesRegex(ValueError, "native primitive"):
            verify_manipulation_stopping("vima-bench", [{**vima, "nativeAction": action}], 5)

    def test_requires_explicit_complete_semantically_equal_mapping(self):
        with self.assertRaisesRegex(ValueError, "exactly"):
            resolve_binding(self.benchmark_profile, self.policy_profile, {})
        changed = copy.deepcopy(self.policy_profile)
        changed["observations"]["state"]["frame"] = "tool"
        with self.assertRaisesRegex(ValueError, "semantics"):
            resolve_binding(self.benchmark_profile, changed, {"state": "state"})
        self.assertEqual(self.binding, resolve_binding(self.benchmark_profile, self.policy_profile, {"state": "state"}))

    def test_stops_mid_chunk_and_keeps_full_requested_chunk(self):
        benchmark, policy = SyntheticBenchmark(success_at=2), SyntheticPolicy()
        result = self.run_sample(benchmark, policy)
        self.assertTrue(result["success"])
        self.assertEqual(result["steps"], 2)
        self.assertEqual(policy.calls, 1)
        self.assertEqual(np.load(self.output / "chunks/0.npy").shape, (6, 7))
        self.assertTrue(self.verify()["valid"])
        self.assertTrue(benchmark.closed and policy.closed)

    def test_horizon_failure_is_valid_and_replans_after_consumed_prefix(self):
        policy = SyntheticPolicy()
        result = self.run_sample(SyntheticBenchmark(), policy)
        self.assertTrue(result["valid"])
        self.assertFalse(result["success"])
        self.assertEqual(policy.calls, 2)
        self.assertEqual(self.verify()["steps"], 7)

    def test_first_chunk_can_be_shorter_than_the_steady_replan_interval(self):
        policy = SyntheticPolicy()
        predict = policy.act
        def act(observation):
            actions = predict(observation)
            return actions[:2 if policy.calls == 1 else 5]
        policy.act = act
        parameters = {"firstReplanSteps": 2, "replanSteps": 5}
        result = self.run_sample(SyntheticBenchmark(), policy, {"reference": {"parameters": parameters}})
        self.assertTrue(result["valid"])
        self.assertEqual(policy.calls, 2)
        self.assertEqual(np.load(self.output / "chunks/0.npy").shape, (2, 7))
        rows = [json.loads(line) for line in (self.output / "actions.jsonl").read_text().splitlines()]
        self.assertEqual([row["sourceObservation"] for row in rows], [0, 0, 2, 2, 2, 2, 2])
        self.assertTrue(self.verify()["valid"])

    def test_nonfinite_policy_and_environment_failure_remain_invalid(self):
        result = self.run_sample(SyntheticBenchmark(), SyntheticPolicy(invalid=True))
        self.assertEqual(result["failure"], "policy_act")
        self.assertFalse(self.verify()["valid"])
        self.assertTrue(np.isnan(np.load(self.output / "chunks/0.npy", allow_pickle=False)).all())

    def test_asset_preflight_failure_is_sealed_as_reset_failure(self):
        class UnstartedBenchmark(SyntheticBenchmark):
            def reset(self, sample):
                raise AssertionError("asset preflight should fail first")

        def prepare():
            raise ValueError("mounted simulator asset digest mismatch")

        result = run_episode(UnstartedBenchmark(), SyntheticPolicy(), self.sample, self.binding,
                             self.output, "synthetic-trial.attempt", {"fixture": True}, prepare=prepare)
        self.assertFalse(result["valid"])
        self.assertEqual(result["failure"], "reset_failed")
        self.assertEqual(result["steps"], 0)
        self.assertEqual(result["issues"], ["mounted simulator asset digest mismatch"])
        self.assertEqual(self.verify(), result)

    def test_completed_actions_survive_later_environment_failure(self):
        result = self.run_sample(SyntheticBenchmark(fail_at=3), SyntheticPolicy())
        self.assertEqual(result["failure"], "env_step")
        self.assertEqual(self.verify()["steps"], 3)
        self.assertFalse(result["valid"])

    def test_converted_actions_keep_raw_output_and_are_audited(self):
        class Converting(SyntheticPolicy):
            conversion = "libero-gripper"

        result = self.run_sample(SyntheticBenchmark(success_at=2), Converting())
        raw = np.load(self.output / "chunks/0.raw.npy")
        executed = np.load(self.output / "chunks/0.npy")
        np.testing.assert_array_equal(raw[:, :-1], executed[:, :-1])
        np.testing.assert_array_equal(executed[:, -1], -np.sign(2 * raw[:, -1] - 1))
        self.assertTrue(self.verify()["success"])
        np.save(self.output / "chunks/0.raw.npy", raw + 1, allow_pickle=False)
        seal(self.output, result)
        with self.assertRaisesRegex(ValueError, "conversion"):
            self.verify()

    def test_final_step_past_the_episode_deadline_is_invalid(self):
        import time

        class SlowLastStep(SyntheticBenchmark):
            def step(self, action):
                native = super().step(action)
                if self.count == self.success_at:
                    time.sleep(0.3)
                return native

        result = run_episode(SlowLastStep(success_at=2), SyntheticPolicy(), self.sample, self.binding,
                             self.output, "synthetic-trial.attempt", {"fixture": True},
                             deadline=time.monotonic() + 0.2)
        self.assertFalse(result["valid"])
        self.assertEqual(result["failure"], "call_watchdog")
        self.assertFalse(self.verify()["valid"])
        # Resealing the late step as a valid success is rejected by the verifier.
        result.update(valid=True, success=True, failure=None)
        seal(self.output, result)
        with self.assertRaisesRegex(ValueError, "deadline"):
            self.verify()

    def test_rejected_raw_output_keeps_preceding_controls_and_call_identity(self):
        class RejectingPolicy(SyntheticPolicy):
            def act(self, observation):
                if self.calls:
                    raise EpisodeFailure("policy_act", "synthetic non-finite raw output",
                                         rejected_actions=np.full((6, 7), np.inf, dtype=np.float32))
                return super().act(observation)
        benchmark = SyntheticBenchmark()
        result = self.run_sample(benchmark, RejectingPolicy())
        self.assertEqual(result["failure"], "policy_act")
        self.assertEqual(result["steps"], 5)
        self.assertEqual(benchmark.count, 5)
        self.assertFalse(self.verify()["valid"])
        self.assertTrue(np.isfinite(np.load(self.output / "chunks/0.npy", allow_pickle=False)).all())
        self.assertTrue(np.isposinf(np.load(self.output / "chunks/1.rejected.npy", allow_pickle=False)).all())
        rejection = json.loads((self.output / "chunks/1.rejected.json").read_text())
        self.assertEqual(rejection["sourceObservation"], 5)
        self.assertEqual(rejection["encoding"], "raw-policy-actions")

    def test_rescore_rejects_other_samples_attempts_and_changed_files(self):
        self.run_sample(SyntheticBenchmark(), SyntheticPolicy())
        with self.assertRaisesRegex(ValueError, "another sample"):
            verify_episode(self.output, "other-sample", "synthetic-trial.attempt")
        with self.assertRaisesRegex(ValueError, "another sample"):
            verify_episode(self.output, self.sample["sampleId"], "other-attempt")
        (self.output / "actions.jsonl").write_text("")
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            self.verify()

    def test_internal_action_consistency_even_after_resealing(self):
        result = self.run_sample(SyntheticBenchmark(), SyntheticPolicy())
        path = self.output / "actions.jsonl"
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        rows[0]["action"][0] = 999
        path.write_text("\n".join(json.dumps(row) for row in rows) + "\n")
        seal(self.output, result)
        with self.assertRaisesRegex(ValueError, "differs"):
            self.verify()

    def test_sample_content_is_checked_before_execution_and_after_resealing(self):
        original = copy.deepcopy(self.sample)
        self.sample["initialStateId"] = "1"
        with self.assertRaisesRegex(ValueError, "sampleId"):
            self.run_sample(SyntheticBenchmark(), SyntheticPolicy())
        self.assertFalse(self.output.exists())
        self.sample = original
        result = self.run_sample(SyntheticBenchmark(), SyntheticPolicy())
        contract = json.loads((self.output / "contract.json").read_text())
        contract["sample"]["initialStateId"] = "1"
        contract["sampleDigest"] = digest(contract["sample"])
        write_json(self.output / "contract.json", contract)
        seal(self.output, result)
        with self.assertRaisesRegex(ValueError, "sampleId"):
            self.verify()

    def test_frozen_context_and_execution_identity_survive_logical_trial_changes(self):
        identity = {"reference": {"id": "synthetic-reference"}, "policy": {"name": "synthetic-policy"},
                    "implementationDigest": "sha256:" + "b" * 64,
                    "execution": {"runId": "source-run", "trialId": "synthetic-trial"}}
        result = self.run_sample(SyntheticBenchmark(), SyntheticPolicy(), identity)
        expected = {"trialId": "consolidated-trial", "executionTrialId": "synthetic-trial",
                    "solveRunId": "source-run", "evidenceVersion": 2,
                    "sample": self.sample, "binding": self.binding,
                    "reference": identity["reference"], "policy": identity["policy"],
                    "solveImplementationDigest": identity["implementationDigest"]}
        def verify(context):
            return verify_episode(self.output, self.sample["sampleId"], result["episodeId"], context)
        self.assertTrue(verify(expected)["valid"])
        for key, value in (("solveRunId", "other-run"), ("executionTrialId", "other-trial")):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "another"):
                verify({**expected, key: value})
        original = json.loads((self.output / "contract.json").read_text())
        for key in ("reference", "policy"):
            changed = copy.deepcopy(original)
            changed["identity"][key]["id"] = "other"
            write_json(self.output / "contract.json", changed)
            seal(self.output, result)
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "frozen " + key):
                verify(expected)
        write_json(self.output / "contract.json", original)
        changed_binding = {**self.binding, "version": 9}
        changed_binding["digest"] = digest({k: v for k, v in changed_binding.items() if k != "digest"})
        changed = copy.deepcopy(original)
        changed["bindingDigest"] = changed_binding["digest"]
        write_json(self.output / "resolved-binding.json", changed_binding)
        write_json(self.output / "contract.json", changed)
        seal(self.output, result)
        with self.assertRaisesRegex(ValueError, "frozen binding"):
            verify(expected)
        write_json(self.output / "resolved-binding.json", self.binding)
        del original["identity"]["execution"]
        original["version"] = 1
        write_json(self.output / "contract.json", original)
        seal(self.output, result)
        with self.assertRaisesRegex(ValueError, "another solve Run"):
            verify(expected)
        self.assertTrue(verify({**expected, "evidenceVersion": 1})["valid"])

    def test_quaternion_zero_clipping_and_rotation_direction(self):
        np.testing.assert_array_equal(quaternion_to_axis_angle([0., 0., 0., 1.01]), np.zeros(3))
        np.testing.assert_allclose(quaternion_to_axis_angle([0., 0., 1., 0.]), [0., 0., np.pi])

    def test_optional_video_removal_does_not_invalidate_saved_scoring(self):
        result = self.run_sample(SyntheticBenchmark(), SyntheticPolicy())
        video = self.output / "video.mp4"
        video.write_bytes(b"synthetic optional media")
        seal(self.output, result)
        video.unlink()
        self.assertTrue(self.verify()["valid"])

    def test_optional_video_failure_does_not_replace_native_success(self):
        class BrokenVideo(SyntheticBenchmark):
            def start_video(self, directory):
                raise RuntimeError("synthetic encoder unavailable")
        result = self.run_sample(BrokenVideo(success_at=2), SyntheticPolicy())
        self.assertTrue(result["valid"] and result["success"])
        self.assertTrue(any("optional video" in issue for issue in result["issues"]))
        self.assertTrue(self.verify()["success"])


if __name__ == "__main__":
    unittest.main()
