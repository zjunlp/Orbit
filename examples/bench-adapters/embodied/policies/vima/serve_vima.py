"""Serve the released VIMA checkpoint with the upstream prompt and observation preprocessing."""

import argparse
import asyncio
import os
from pathlib import Path
from urllib.request import urlopen

import numpy as np

from orbit_embodied.assets import tree_digest
from orbit_embodied.binding import file_digest
from orbit_embodied.vima_bench import POSE_FIELDS, VIEWS, unpack_prompt_context
from orbit_embodied.wire import serve_actions


CHECKPOINT = "20M.ckpt"
TOKENIZER = "tokenizer.json"
T5_CONFIG = "t5-config.json"
RANDOMNESS = {"backend": "stateless", "scope": "stateless"}


class VIMAPolicy:
    def __init__(self, weights):
        import torch
        from transformers import AutoModel, T5Config
        from unittest.mock import patch

        from vima import create_policy_from_ckpt
        from vima.nn.prompt_encoder.prompt_encoder import T5EncoderModel

        torch.set_num_threads(4)
        config = T5Config.from_json_file(str(weights / T5_CONFIG))
        # Strict loading of the released checkpoint restores the encoder and word embeddings.
        with patch.object(AutoModel, "from_pretrained", side_effect=lambda _: T5EncoderModel(config)), \
                patch.object(T5EncoderModel, "from_pretrained", side_effect=lambda _: T5EncoderModel(config)):
            self.policy = create_policy_from_ckpt(str(weights / CHECKPOINT), "cpu")
        with patch.dict(os.environ, {"VIMA_TOKENIZER": str(weights / TOKENIZER)}):
            from reference import prepare_obs, prepare_prompt
        self.prepare_obs, self.prepare_prompt = prepare_obs, prepare_prompt
        self.reset()

    def reset(self):
        self.obs_tokens, self.obs_masks, self.action_tokens = [], [], []
        self.context = None

    def __call__(self, observation):
        import torch
        from torch.nn.functional import pad
        from vima.utils import add_batch_dim

        with torch.inference_mode():
            if self.context is None:
                self.context = unpack_prompt_context(observation["prompt_context"])
                tokens, words, images = self.prepare_prompt(
                    prompt=observation["instruction"], prompt_assets=self.context["assets"], views=list(VIEWS))
                self.prompt = self.policy.forward_prompt_assembly((tokens, words, images))
            ids = self.context["objectIds"]
            raw = {"rgb": {view: observation[view + "_rgb"] for view in VIEWS},
                   "segm": {view: observation[view + "_segm"] for view in VIEWS},
                   "ee": np.asarray(observation["ee"][0], dtype=np.int64)}
            meta = {"n_objects": len(ids), "obj_id_to_info": dict.fromkeys(ids)}
            obs = self.prepare_obs(obs=add_batch_dim(raw), meta=meta).to_torch_tensor(device="cpu")
            tokens, mask = self.policy.forward_obs_token(obs)
            self.obs_tokens.append(tokens[0, 0])
            self.obs_masks.append(mask[0, 0])
            width = max(len(item) for item in self.obs_masks)
            tokens = torch.stack([pad(item, (0, 0, 0, width - len(item))) for item in self.obs_tokens])[:, None]
            masks = torch.stack([pad(item, (0, width - len(item))) for item in self.obs_masks])[:, None]
            actions = torch.stack(self.action_tokens)[:, None] if self.action_tokens else None
            predicted = self.policy.forward(obs_token=tokens, obs_mask=masks, action_token=actions,
                                            prompt_token=self.prompt[0], prompt_token_mask=self.prompt[1])
            decoded = {key: dist.mode() for key, dist in self.policy.forward_action_decoder(predicted[-1:]).items()}
            self.action_tokens.append(self.policy.forward_action_token(decoded)[0, 0])
            native = self.policy._de_discretize_actions(decoded)
            low, high = self.context["bounds"]["low"], self.context["bounds"]["high"]
            parts = []
            for key, _ in POSE_FIELDS:
                values = native[key][0, 0].cpu().numpy()
                parts.append(np.clip(values * (high - low) + low, low, high) if key.endswith("position")
                             else np.clip(values * 2 - 1, -1, 1))
            return np.concatenate(parts).astype(np.float32)[None, :]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--checkpoint-digest")
    parser.add_argument("--normalization-digest")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--healthcheck", action="store_true")
    args = parser.parse_args()
    if args.healthcheck:
        with urlopen(f"http://127.0.0.1:{args.port}/healthz", timeout=3) as response:
            if response.read() != b"OK\n":
                raise RuntimeError("VIMA is not ready")
        return
    if args.weights is None or not args.checkpoint_digest or not args.normalization_digest:
        parser.error("--weights and content digests are required")
    if (tree_digest(args.weights) != args.checkpoint_digest
            or file_digest(args.weights / TOKENIZER) != args.normalization_digest):
        raise ValueError("VIMA checkpoint or tokenizer differs from the frozen registration")
    policy = VIMAPolicy(args.weights)
    metadata = {"replanSteps": 1, "actionSize": 12, "orbit": {
        "checkpointDigest": args.checkpoint_digest, "normalizationDigest": args.normalization_digest,
        "randomness": RANDOMNESS,
    }}
    asyncio.run(serve_actions(policy, metadata, "0.0.0.0", args.port, reset=policy.reset))


if __name__ == "__main__":
    main()
