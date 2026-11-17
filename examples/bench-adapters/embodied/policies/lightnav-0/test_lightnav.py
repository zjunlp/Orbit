import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import numpy as np

from orbit_embodied import StepResult, digest, resolve_binding, run_episode, verify_episode
from orbit_embodied.binding import file_digest
from orbit_embodied.conversions import LIGHTNAV_HSSD_VELOCITY, lightnav_hssd_velocity
from orbit_embodied.evidence import seal, write_json
from orbit_embodied.hssd_ov import semantic_profile


def load_server():
    path = Path(__file__).with_name("serve_lightnav.py")
    spec = importlib.util.spec_from_file_location("lightnav_server", path)
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)
    return server


class LightNavProjectionTests(unittest.TestCase):
    def test_configurator_help_without_third_party_packages(self):
        configurator = Path(__file__).with_name("configure_lightnav.py")
        result = subprocess.run([sys.executable, "-B", "-E", "-S", str(configurator), "--help"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--policy-image", result.stdout)

    def test_loader_only_sees_verified_release_files(self):
        server = load_server()
        with tempfile.TemporaryDirectory() as directory:
            weights = Path(directory)
            files = {}
            for name in ("model-00001-of-00001.safetensors", "model.safetensors.index.json",
                         "config.json", "action_tokenizer/codebook_l0.npy"):
                file = weights / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(name)
                files[name] = file_digest(file)
            for name in ("model.safetensors", "generation_config.json"):
                (weights / name).write_text("unlisted")
            release = {"files": files}
            with server.release_directory(weights, release) as view:
                self.assertEqual({file.relative_to(view).as_posix() for file in view.rglob("*")
                                  if file.is_file()}, set(files))
                self.assertEqual(server.identity(view, release), server.identity(weights, release))
            self.assertFalse(view.exists())

    def test_project_normalized_velocity_to_native_action(self):
        for linear, angular, expected in ((-1, 0, 0), (0, 0, 1), (-1, 1, 2), (-1, -1, 3),
                                          (0.8, 0.6, 1), (-0.2, 0.6, 2), (0.8, -0.95, 3)):
            with self.subTest(linear=linear, angular=angular):
                np.testing.assert_array_equal(lightnav_hssd_velocity([[linear, angular, 1]]), [[expected]])
        for linear in (float("nan"), 1.5):
            with self.assertRaisesRegex(ValueError, "outside the normalized range"):
                lightnav_hssd_velocity([[linear, 0, 1]])
        np.testing.assert_array_equal(lightnav_hssd_velocity([[-1, 0, 0]]), [[0]])
        for raw in ([[-1, 0, 2]], [[0, 0, 0]]):
            with self.assertRaisesRegex(ValueError, "decode status or fallback velocity"):
                lightnav_hssd_velocity(raw)

    def test_records_raw_velocity_and_requires_matching_frozen_conversion(self):
        class Benchmark:
            action_size, horizon, settle_steps = 1, 2, 0

            def reset(self, sample):
                return {"instruction": "Find the vase."}

            def state(self, observation):
                return observation

            def step(self, action):
                stopped = action[0] == 0
                return StepResult(self.reset(None), 0, stopped, False, native_action=action.tolist())

            def result(self):
                return {"success": False}

            def close(self):
                pass

        raw_chunks = [np.array([[-0.75, 0.875, 1.0]]), np.array([[-1.0, 0.0, 0.0]])]

        class Policy:
            conversion, replan_steps = LIGHTNAV_HSSD_VELOCITY, 1

            def reset(self, sample):
                self.chunks = iter(raw_chunks)

            def act(self, observation):
                return next(self.chunks)

            def close(self):
                pass

        profile = semantic_profile()
        profile["observations"] = {"instruction": profile["observations"]["instruction"]}
        binding = resolve_binding(profile, profile, {"instruction": "instruction"})
        sample = {"taskId": "test"}
        sample["sampleId"] = digest(sample)
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "episode"
            identity = {"policy": {"actionConversion": LIGHTNAV_HSSD_VELOCITY}}
            result = run_episode(Benchmark(), Policy(), sample, binding, directory, "test", identity)
            self.assertTrue(result["valid"], result["issues"])

            def verify():
                return verify_episode(directory, sample["sampleId"], "test")

            self.assertEqual(verify(), result)
            for index, expected in enumerate(raw_chunks):
                np.testing.assert_array_equal(np.load(directory / f"chunks/{index}.raw.npy"), expected)
            raw = directory / "chunks/0.raw.npy"
            np.save(raw, [[-0.75, -0.875, 1.0]])
            seal(directory, result)
            with self.assertRaisesRegex(ValueError, "differ from the recorded conversion"):
                verify()
            raw.unlink()
            seal(directory, result)
            with self.assertRaisesRegex(ValueError, "lacks its raw model output"):
                verify()
            path = directory / "chunks/0.json"
            timing = json.loads(path.read_text())
            del timing["conversion"]
            write_json(path, timing)
            seal(directory, result)
            with self.assertRaisesRegex(ValueError, "conversion differs from the frozen policy"):
                verify()
