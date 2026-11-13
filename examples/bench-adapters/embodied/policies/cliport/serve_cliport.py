"""Serve the published multi-task CLIPort agent over the Orbit policy wire."""

import argparse
import asyncio
from pathlib import Path

from orbit_embodied.binding import file_digest, validate_observation
from orbit_embodied.cliport import ACTIONS, CAMERAS, flatten_action, profile
from orbit_embodied.wire import serve_actions


CHECKPOINT_DIGEST = "sha256:c3283f1824d49e4f5fc930ab8f49e612cf133a22b2e70ec8871e161d178f0a20"
CONFIG_DIGEST = "sha256:a29f3cc370290dc1a22de03140143f9408a15848e8cbbcc46592ce5610692591"
BACKBONE_DIGEST = "sha256:afeb0e10f9e5a86da6080e35cf09123aca3b358a0c3e3b6c78a7b63bc04b6762"


def check_weights(directory):
    for name, checksum in (("model.ckpt", CHECKPOINT_DIGEST), ("config.yaml", CONFIG_DIGEST),
                           ("RN50.pt", BACKBONE_DIGEST)):
        if file_digest(directory / name) != checksum:
            raise ValueError("CLIPort weights differ from the pinned release: " + name)


def load_agent(directory):
    import tempfile
    from unittest.mock import patch

    from cliport import agents
    from cliport.dataset import RavensDataset
    from cliport.models import clip_lingunet_lat
    from omegaconf import OmegaConf
    from pytorch_lightning.callbacks import ModelCheckpoint
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("CLIPort reference policy requires its assigned CUDA device")
    config = OmegaConf.load(directory / "config.yaml")
    # The released 2021 config predates these renamed training-only fields.
    config.train.val_repeats = config.train.val_iter
    config.train.save_steps = config.train.save_iterations

    def local_backbone(name, device):
        if name != "RN50":
            raise ValueError("unexpected CLIPort backbone")
        # CLIPort rebuilds an eager model from these weights before inference.
        return torch.jit.load(str(directory / "RN50.pt"), map_location="cpu").eval(), None

    with tempfile.TemporaryDirectory(prefix="cliport-inference-") as empty_data:
        with patch.object(clip_lingunet_lat, "load_clip", local_backbone):
            dataset = RavensDataset(empty_data, config, augment=False)
            agent = agents.names["cliport"]("cliport-multi-language-conditioned", config, None, dataset)
    # Old Lightning metadata uses the callback class as a dictionary key.
    with torch.serialization.safe_globals([ModelCheckpoint]):
        checkpoint = torch.load(directory / "model.ckpt", map_location="cpu", weights_only=True)
    agent.load_state_dict(checkpoint["state_dict"])
    # Match the module modes left by the upstream agent.load() in eval.py.
    return agent.to(agent.device_type)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--primitive", choices=ACTIONS, required=True)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    check_weights(args.weights)

    import torch
    agent = load_agent(args.weights)
    policy_profile = profile("policy", args.primitive)
    observations = policy_profile["observations"]

    @torch.inference_mode()
    def act(observation):
        validate_observation(observation, observations)
        raw = {"color": [observation[name + "_rgb"] for name in CAMERAS],
               "depth": [observation[name + "_depth"] for name in CAMERAS]}
        action = flatten_action(agent.act(raw, {"lang_goal": observation["instruction"]}))
        if args.primitive == "push":
            action = action[[0, 1, 7, 8]]
        return action[None, :]

    metadata = {"actionSize": policy_profile["action"]["shape"][0], "replanSteps": 1, "orbit": {"checkpointDigest": CHECKPOINT_DIGEST, "normalizationDigest": CONFIG_DIGEST,
                          "backboneDigest": BACKBONE_DIGEST, "randomness": {"backend": "stateless", "scope": "stateless"}}}
    asyncio.run(serve_actions(act, metadata, args.host, args.port))


if __name__ == "__main__":
    main()
