"""RoboMimic's native RoboSuite evaluation reset and stopping protocol."""

from copy import deepcopy

import numpy as np

from .binding import digest
from .driver import StepResult
from .gym import GymBenchmark


class RoboMimicBenchmark(GymBenchmark):
    def __init__(self, reference, task):
        super().__init__(reference, task)
        self.fields = reference["benchmarkProfile"]["observations"]
        self.action_size = reference["benchmarkProfile"]["action"]["shape"][0]

    def reset(self, sample):
        from robomimic.envs.env_robosuite import EnvRobosuite
        from robomimic.utils.obs_utils import initialize_obs_modality_mapping_from_dict

        seed = self.reset_seed(sample)
        np.random.seed(seed)
        metadata = self.reference["environment"]["envMetadata"]
        rgb = [key for key, field in self.fields.items() if field["semantic"] == "rgb"]
        initialize_obs_modality_mapping_from_dict(
            {"low_dim": [key for key in self.fields if key not in rgb], "rgb": rgb}
        )
        kwargs = deepcopy(metadata["env_kwargs"])
        if rgb:
            kwargs["camera_names"] = [self.fields[key]["camera"] for key in rgb]
        self.env = EnvRobosuite(metadata["env_name"], use_image_obs=bool(rgb), **kwargs)
        if self.env.action_dimension != self.action_size:
            raise ValueError("RoboMimic controller differs from the frozen dataset metadata")
        self.env.reset()
        native = self.env.get_state()
        self.initial_digest = digest(np.asarray(native["states"]).tolist())
        self.success, self.steps = False, 0
        return self.observation(self.env.reset_to(native))

    def observation(self, native):
        return {key: np.ascontiguousarray(native[key], dtype=field["dtype"]) for key, field in self.fields.items()}

    def start_video(self, directory):
        if any(field["semantic"] == "rgb" for field in self.fields.values()):
            super().start_video(directory)

    def record_frame(self, observation):
        if self.video is not None:
            super().record_frame(observation)

    def state(self, observation):
        return {**super().state(observation), "resetStateDigest": self.initial_digest}

    def step(self, action):
        observation, reward, done, _ = self.env.step(action)
        self.steps += 1
        self.success = bool(self.env.is_success()["task"])
        return StepResult(self.observation(observation), float(reward),
                          bool(done or self.success or self.steps == self.horizon),
                          self.success, native_done=bool(done))

    def result(self):
        return {"success": self.success, "source": "RoboMimic task success", "task": self.task}

    def close(self):
        if self.env is not None:
            self.env.env.close()
            self.env = None
