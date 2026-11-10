"""VIMA-Bench test partitions with native multimodal prompts and primitive actions."""

from base64 import b64decode, b64encode

import numpy as np

from .binding import digest
from .driver import StepResult
from .gym import GymBenchmark
from .wire import pack, unpack


VIEWS = ("front", "top")
POSE_FIELDS = (("pose0_position", 2), ("pose0_rotation", 4),
               ("pose1_position", 2), ("pose1_rotation", 4))


def primitive_action(action):
    parts = {}
    offset = 0
    for name, size in POSE_FIELDS:
        parts[name] = np.asarray(action[offset:offset + size], dtype=np.float32)
        offset += size
    return parts


def prompt_context(env):
    assets = {}
    for name, asset in env.prompt_assets.items():
        kind = asset["placeholder_type"]
        info = asset["segm"]["obj_info"]
        # Only object IDs are used by the reference policy's prompt assembly.
        ids = ({"obj_id": int(info["obj_id"])} if kind == "object" else
               [{"obj_id": int(item["obj_id"])} for item in info])
        assets[name] = {"placeholder_type": kind, "rgb": asset["rgb"],
                        "segm": {**{view: asset["segm"][view] for view in VIEWS}, "obj_info": ids}}
    return b64encode(pack({
        "assets": assets,
        "objectIds": [int(key) for key in env.meta_info["obj_id_to_info"]],
        "bounds": env.meta_info["action_bounds"],
    })).decode("ascii")


def unpack_prompt_context(value):
    return unpack(b64decode(value, validate=True))


class VIMABenchBenchmark(GymBenchmark):
    action_size = 12

    def reset(self, sample):
        from vima_bench import PARTITION_TO_SPECS, make

        seed = self.reset_seed(sample)
        partition = self.reference["environment"]["partition"]
        task_kwargs = PARTITION_TO_SPECS["test"][partition][self.task]
        self.env = make(self.task, task_kwargs=task_kwargs, modalities=["segm", "rgb"],
                        seed=seed, hide_arm_rgb=False)
        if self.env.task.oracle_max_steps + 2 != self.horizon:
            raise ValueError("VIMA-Bench horizon differs from the frozen test partition")
        self.success, self.steps = False, 0
        observation = self.env.reset()
        self.prompt = self.env.prompt
        self.context = prompt_context(self.env)
        self.context_digest = digest([self.prompt, self.context])
        return self.observation(observation)

    def observation(self, native):
        return {**{view + "_rgb": native["rgb"][view] for view in VIEWS},
                **{view + "_segm": native["segm"][view] for view in VIEWS},
                "ee": np.asarray([native["ee"]], dtype=np.uint8), "instruction": self.prompt,
                "prompt_context": self.context}

    def record_frame(self, observation):
        self.video.append_data(np.moveaxis(observation["front_rgb"], 0, -1))

    def state(self, observation):
        return {"promptDigest": self.context_digest, "endEffector": int(observation["ee"][0])}

    def step(self, action):
        native = primitive_action(action)
        observation, reward, done, info = self.env.step(native)
        self.steps += 1
        self.success = bool(info["success"])
        return StepResult(self.observation(observation), float(reward), bool(done or self.steps == self.horizon),
                          self.success, native_action=np.concatenate(list(native.values())).tolist(),
                          native_done=bool(done))

    def result(self):
        return {"success": self.success, "source": "VIMA-Bench task success", "task": self.task}
