"""Serve the released SPOC and FLaRe Stretch policies through Orbit's policy protocol."""

import argparse
import asyncio
import json
from pathlib import Path

from orbit_embodied.binding import digest, file_digest
from orbit_embodied.chores import ACTIONS, ARM_CAMERA, IN_HAND, NAV_CAMERA

RELEASE = Path(__file__).with_name("release.json")
RANDOMNESS = {"backend": "torch", "scope": "service", "initialSeed": 0}


def asset_identity(root, release):
    files = release["files"]
    for name, checksum in files.items():
        if file_digest(root / name) != checksum:
            raise ValueError("CHORES policy asset differs from the pinned release: " + name)
    checkpoint = root / release["checkpoint"]
    if checkpoint.stat().st_size != release["bytes"]:
        raise ValueError("CHORES policy checkpoint is incomplete or from another release")
    checkpoint_digest = file_digest(checkpoint)
    if checkpoint_digest != release["checkpointDigest"]:
        raise ValueError("CHORES policy checkpoint differs from the pinned release")
    return {"checkpointDigest": checkpoint_digest, "normalizationDigest": digest(files)}


def make_agent(model, weights, release):
    import torch

    device = torch.device("cuda:0")
    checkpoint = str(weights / release["checkpoint"])
    torch.manual_seed(0)
    if model.startswith("spoc-"):
        import yaml
        from architecture.models.transformer_models import REGISTERED_MODELS

        config = yaml.safe_load((weights / "config.yaml").read_text())
        values = {key: config[key]["value"] for key in ("model", "model_version", "loss", "input_sensors")}
        model_name = values.pop("model")
        if set(values["input_sensors"]) != {NAV_CAMERA, ARM_CAMERA, IN_HAND, "last_actions"}:
            raise ValueError("SPOC RGB checkpoint has an unexpected sensor profile")
        agent = REGISTERED_MODELS[model_name].build_agent(
            **values, sampling="sample", device=device, ckpt_pth=checkpoint)
        agent.model.eval()
        agent.preprocessor.cfg.data_augmentation = False
        return agent
    from architecture.allenact_preprocessors.dino_preprocessors import DinoViTPreprocessor
    from architecture.models.allenact_transformer_models.inference_agent import InferenceAgentVIDA
    from training.online.dinov2_vits_tsfm_rgb_augment_objectnav import (
        DinoV2ViTSTSFMObjectNav, DinoV2ViTSTSFMObjectNavParams,
    )
    from utils.data_utils import LazyJsonHouses

    class InferenceConfig(DinoV2ViTSTSFMObjectNav):
        # The upstream constructor eagerly opens simulator houses that the policy never uses.
        def get_houses(self, subset):
            return LazyJsonHouses(data=[])

    params = DinoV2ViTSTSFMObjectNavParams()
    params.num_train_processes = 0
    params.use_bbox = False
    params.use_data_augmentation = False
    agent = InferenceAgentVIDA.build_agent(
        exp_config_type=InferenceConfig, params=params, device=device,
        img_encoder_rgb_mean=DinoViTPreprocessor.DINO_RGB_MEANS,
        img_encoder_rgb_std=DinoViTPreprocessor.DINO_RGB_STDS, greedy_sampling=False,
        test_augmentation=False, ckpt_path=checkpoint,
    )
    agent.actor_critic.eval()
    return agent


def main():
    import numpy as np
    import torch
    from orbit_embodied.wire import serve_actions

    releases = json.loads(RELEASE.read_text())
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=tuple(releases), required=True)
    parser.add_argument("--weights", required=True, type=Path)
    parser.add_argument("--backbone-digest", required=True)
    parser.add_argument("--checkpoint-digest", required=True)
    parser.add_argument("--normalization-digest", required=True)
    args = parser.parse_args()
    record = releases[args.model]
    identity = asset_identity(args.weights, record)
    if identity != {"checkpointDigest": args.checkpoint_digest, "normalizationDigest": args.normalization_digest}:
        raise ValueError("CHORES policy identity differs from the registration")
    from orbit_embodied.assets import tree_digest

    if tree_digest("/opt/chores-backbones") != args.backbone_digest:
        raise ValueError("CHORES backbone identity differs from the registration")
    agent = make_agent(args.model, args.weights, record)
    if tuple(agent.get_action_list()) != ACTIONS:
        raise ValueError("CHORES model action order differs from the native Stretch protocol")
    fields = (NAV_CAMERA, ARM_CAMERA, IN_HAND)

    @torch.no_grad()
    def predict(observation):
        inputs = {key: np.array(observation[key], copy=True) for key in fields}
        action, _ = agent.get_action(inputs, observation["instruction"])
        if action not in ACTIONS:
            raise ValueError("CHORES policy returned an unsupported action")
        return np.asarray([[ACTIONS.index(action)]], dtype=np.int32)

    metadata = {"replanSteps": 1, "actionSize": 1, "orbit": {**identity, "backboneDigest": args.backbone_digest,
                                                        "randomness": RANDOMNESS}}
    asyncio.run(serve_actions(predict, metadata, "0.0.0.0", 8000, reset=agent.reset))


if __name__ == "__main__":
    main()
