"""Serve the released LingBot-VA RoboTwin checkpoint with per-episode KV cache."""

import argparse
import asyncio
from copy import deepcopy
import json
from pathlib import Path
import tempfile

import numpy as np

from orbit_embodied.binding import digest, file_digest
from orbit_embodied.robotwin import RoboTwinLingBotBenchmark
from orbit_embodied.wire import serve_actions


CAMERAS = dict(zip(RoboTwinLingBotBenchmark.camera_names, (
    "observation.images.cam_high", "observation.images.cam_left_wrist", "observation.images.cam_right_wrist",
)))
REPLAN = RoboTwinLingBotBenchmark.chunk_controls


def checkpoint_digest(root):
    paths = {"tokenizer/" + name for name in ("special_tokens_map.json", "spiece.model", "tokenizer.json",
                                              "tokenizer_config.json")}
    paths.update(("vae/config.json", "vae/diffusion_pytorch_model.safetensors"))
    for component, index in (("text_encoder", "model.safetensors.index.json"),
                             ("transformer", "diffusion_pytorch_model.safetensors.index.json")):
        paths.update((component + "/config.json", component + "/" + index))
        shards = set(json.loads((root / component / index).read_text())["weight_map"].values())
        if not shards or any(Path(name).name != name or not name.endswith(".safetensors") for name in shards):
            raise ValueError("LingBot-VA weight index has invalid shard names")
        paths.update(component + "/" + name for name in shards)
    actual = {path.relative_to(root).as_posix() for component in ("tokenizer", "text_encoder", "transformer", "vae")
              for path in (root / component).rglob("*") if path.is_file() or path.is_symlink()}
    if actual != paths or any((root / name).is_symlink() for name in paths):
        raise ValueError("LingBot-VA requires exactly the release model, tokenizer and indexed weight shards")
    return digest({name: file_digest(root / name) for name in sorted(paths)})


def native_actions(action, pose):
    from scipy.spatial.transform import Rotation

    native = np.moveaxis(action, 0, -1).reshape(-1, 16).astype(np.float64)
    for offset in (0, 8):
        native[:, offset:offset + 3] += pose[offset:offset + 3]
        # The pinned reference multiplies the two quaternions as xyzw, then forwards
        # that result unchanged to RoboTwin. Preserve the numerical convention.
        start, end = offset + 3, offset + 7
        native[:, start:end] = (Rotation.from_quat(pose[start:end])
                                * Rotation.from_quat(native[:, start:end])).as_quat()
    return native


class LingBotPolicy:
    def __init__(self, model):
        self.model = model
        self.reset()

    def reset(self):
        self.previous = None
        self.initial = None
        self.pose = None

    def infer(self, observation):
        def frame(index):
            return {**{slot: observation[key + "_history"][index] for key, slot in CAMERAS.items()},
                    "task": observation["instruction"]}

        prompt = observation["instruction"]
        first = self.previous is None
        if first:
            self.initial = frame(-1)
            self.model.infer({"reset": True, "prompt": prompt, "save_visualization": False})
            self.pose = observation["initial_ee_pose"]
        else:
            # The first 16 controls supply four keyframes; later chunks supply eight.
            self.model.infer({"obs": [frame(i) for i in range(-self.keyframe_count, 0)],
                              "compute_kv_cache": True, "imagine": False,
                              "save_visualization": False, "state": self.previous})
        action = np.asarray(self.model.infer({"obs": self.initial, "prompt": prompt,
                                             "save_visualization": False})["action"])
        if action.shape != (16, 2, 16) or not np.isfinite(action).all():
            raise ValueError("LingBot-VA must return a finite (16, 2, 16) RoboTwin chunk")
        self.previous = action
        executed = action[:, 1:, :] if first else action
        self.keyframe_count = executed.shape[1] * executed.shape[2] // RoboTwinLingBotBenchmark.frame_stride
        return native_actions(executed, self.pose)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--checkpoint-digest", required=True)
    parser.add_argument("--normalization-digest", required=True)
    parser.add_argument("--cpu-threads", type=int, default=8)
    args = parser.parse_args()

    import torch
    import wan_va_server as upstream

    torch.set_num_threads(args.cpu_threads)
    if checkpoint_digest(args.weights) != args.checkpoint_digest:
        raise ValueError("LingBot-VA checkpoint differs from the frozen registration")
    config = deepcopy(upstream.VA_CONFIGS["robotwin"])
    if file_digest(Path(upstream.__file__).parent / "configs/va_robotwin_cfg.py") != args.normalization_digest:
        raise ValueError("LingBot-VA normalization differs from the frozen registration")
    config.wan22_pretrained_model_name_or_path = str(args.weights)
    config.enable_offload = True
    config.local_rank = 0
    torch.manual_seed(0)
    upstream.init_logger()
    # These unconditional upstream debug dumps are outside the inference and scoring protocol.
    upstream.save_async = lambda *_args: None
    metadata = {"actionSize": 16, "replanSteps": REPLAN, "orbit": {
        "checkpointDigest": args.checkpoint_digest, "normalizationDigest": args.normalization_digest,
        "randomness": {"backend": "torch", "initialSeed": 0, "scope": "service"},
    }}
    with tempfile.TemporaryDirectory(prefix="orbit-lingbot-va-") as directory:
        config.save_root = directory
        policy = LingBotPolicy(upstream.VA_Server(config))
        asyncio.run(serve_actions(policy.infer, metadata, "0.0.0.0", 8000, reset=policy.reset))


if __name__ == "__main__":
    main()
