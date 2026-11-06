"""Synthetic Gym boundaries; these checks do not replace native simulator calibration."""

import copy
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

import numpy as np

from orbit_embodied import digest, resolve_binding, run_episode, verify_episode
from orbit_embodied.binding import seed_asset
from orbit_embodied.evidence import seal, write_json
from orbit_embodied.gym import GymBenchmark


REFERENCE = json.loads((Path(__file__).resolve().parents[2] / "bench-adapters/embodied/profiles/groot-widowx.json").read_text())


class Native:
    def __init__(self):
        self.steps = 0

    def step(self, command):
        self.steps += 1
        observation = {name: "synthetic task" if description["dtype"] == "string" else
                       np.zeros(description["shape"], dtype=description["dtype"])
                       for name, description in REFERENCE["benchmarkProfile"]["observations"].items()}
        return observation, 0., False, False, {"success": self.steps == 2}


class Wrapper:
    def __init__(self):
        self.env, self.unwrapped = Native(), self
        self.seed, self.closed = None, False

    def reset(self, seed):
        self.seed = seed
        observation = self.env.step(np.zeros(7))[0]
        self.env.steps = 0
        return observation, {}

    def step(self, action):
        vector = np.concatenate([action["action." + key] for key in REFERENCE["benchmarkProfile"]["action"]["order"]])
        vector[-1] = 2 * (vector[-1] > .5) - 1
        return self.env.step(vector)

    def close(self):
        self.closed = True


class Policy:
    replan_steps = 4

    def reset(self, sample):
        pass

    def act(self, observation):
        return np.zeros((16, 7), dtype=np.float32)

    def close(self):
        pass


class GymTests(unittest.TestCase):
    def test_reset_identity_macro_step_success_and_native_actions_are_preserved(self):
        reference = copy.deepcopy(REFERENCE)
        task = reference["environment"]["tasks"][0]
        content = {"taskId": task, "benchmarkProfile": reference["id"], "initialStateId": "1",
                   "initialStateDigest": seed_asset(reference, task), "environmentSeed": 7, "policySeed": 0, "repetition": 0}
        sample = {**content, "sampleId": digest(content)}
        binding = resolve_binding(reference["benchmarkProfile"], reference["policyProfile"], reference["observationMap"])
        wrapper = Wrapper()
        module = types.SimpleNamespace(register_simpler_envs=lambda: None)
        gym = types.SimpleNamespace(make=lambda name: wrapper)
        with tempfile.TemporaryDirectory() as temporary, patch.dict("sys.modules", {
            reference["environment"]["registration"]: module, "gymnasium": gym,
        }):
            directory = Path(temporary) / "episode"
            benchmark = GymBenchmark(reference, task)
            result = run_episode(benchmark, Policy(), sample, binding, directory, "synthetic-trial.attempt", {"reference": reference})
            self.assertEqual(wrapper.seed, 8)
            self.assertTrue(wrapper.closed)
            self.assertTrue(result["success"] and result["valid"])
            self.assertEqual(result["steps"], 4)
            rows = [json.loads(line) for line in (directory / "actions.jsonl").read_text().splitlines()]
            self.assertEqual(rows[0]["nativeAction"][-1], -1)
            self.assertFalse(rows[-1]["nativeSuccess"])
            self.assertTrue(verify_episode(directory, sample["sampleId"], result["episodeId"])["success"])
            contract = json.loads((directory / "contract.json").read_text())
            contract["replanSteps"] = 8
            write_json(directory / "contract.json", contract)
            seal(directory, result)
            with self.assertRaisesRegex(ValueError, "execution horizon"):
                verify_episode(directory, sample["sampleId"], result["episodeId"])


if __name__ == "__main__":
    unittest.main()
