"""Serve the released Fast-VLA RoboTwin policy with per-episode task memory."""

import argparse
import asyncio
import os
from pathlib import Path

import numpy as np

from orbit_embodied.assets import tree_digest
from orbit_embodied.binding import digest, file_digest


CAMERAS = ("head_camera", "left_camera", "right_camera")
HISTORY = (17, 8)
CHUNK = 50


def model_inputs(observation):
    views = [observation[camera] for camera in CAMERAS]
    history = {-steps: [observation[f"head_camera_t_minus_{steps}"], *views[1:]] for steps in HISTORY}
    return views, np.asarray(observation["joint_state"], dtype=np.float32), observation["instruction"], history


def build_model(weights):
    os.environ["HF_HUB_CACHE"] = str(weights / "hub")
    from fastvla.policy import FastVLAPolicy

    model = FastVLAPolicy(str(weights / "actor"), vlm_repo=str(weights / "dm05"))
    if ((model.bench, model.chunk, model.n_arms, model.n_view, model.action_dim) != ("robotwin", CHUNK, 2, 3, 14)
            or model.hist_offsets != [-17, -8]
            or any(camera != 0 for camera, offset in zip(model.cam_of_slot, model.slot_time) if offset != 0)):
        raise ValueError("Fast-VLA checkpoint does not implement the frozen RoboTwin history recipe")
    return model


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--checkpoint-digest", required=True)
    parser.add_argument("--normalization-digest", required=True)
    parser.add_argument("--backbone-digest", required=True)
    args = parser.parse_args()
    backbone = digest({"dm05": tree_digest(args.weights / "dm05"), "vision": tree_digest(args.weights / "hub")})
    if (tree_digest(args.weights / "actor") != args.checkpoint_digest
            or file_digest(args.weights / "actor/norm_stats.json") != args.normalization_digest
            or backbone != args.backbone_digest):
        raise ValueError("Fast-VLA assets differ from the frozen registration")

    from orbit_embodied.wire import serve_actions

    model = build_model(args.weights)

    def infer(observation):
        actions = np.asarray(model.act(*model_inputs(observation)))
        if actions.shape != (CHUNK, 14) or not np.isfinite(actions).all():
            raise ValueError("Fast-VLA must return fifty finite RoboTwin joint targets")
        return actions

    identity = {"checkpointDigest": args.checkpoint_digest, "normalizationDigest": args.normalization_digest,
                "backboneDigest": args.backbone_digest,
                "randomness": {"backend": "stateless", "scope": "stateless"}}
    metadata = {"actionSize": 14, "replanSteps": CHUNK, "orbit": identity}
    asyncio.run(serve_actions(infer, metadata, "0.0.0.0", 8000, reset=model.reset))


if __name__ == "__main__":
    main()
