"""Serve the published RoboCasa365 Diffusion Policy through Orbit's policy wire."""

import argparse
import asyncio
from functools import lru_cache
from hashlib import sha256
from pathlib import Path
from urllib.request import urlopen

import numpy as np

from orbit_embodied.assets import tree_digest
from orbit_embodied.binding import digest, file_digest


CHECKPOINT = "epoch-0500.ckpt"
INSTRUCTION = "annotation.human.task_description"
RANDOMNESS = {"backend": "torch", "initialSeed": 0, "scope": "service"}


def normalization_digest(state):
    fields = {}
    for name, tensor in state.items():
        if name.startswith("normalizer."):
            value = tensor.detach().cpu().contiguous().numpy()
            fields[name] = {"dtype": str(value.dtype), "shape": list(value.shape),
                            "sha256": sha256(value.tobytes()).hexdigest()}
    if not fields:
        raise ValueError("Diffusion Policy checkpoint lacks its normalization tensors")
    return digest(fields)


def load_policy(path, device):
    import dill
    import hydra
    import torch

    # The original checkpoint contains an OmegaConf config and dill-serialized training state.
    payload = torch.load(path, map_location="cpu", pickle_module=dill, weights_only=False)
    cfg = payload["cfg"]
    policy_cfg = cfg.policy
    policy_cfg.n_action_steps = cfg.n_action_steps + cfg.n_latency_steps
    if (policy_cfg.n_obs_steps != 2 or policy_cfg.n_action_steps != 8 or cfg.n_latency_steps != 0
            or list(policy_cfg.shape_meta.action.shape) != [12] or not cfg.training.use_ema):
        raise ValueError("checkpoint differs from the frozen RoboCasa365 Diffusion Policy recipe")
    state = payload["state_dicts"]["ema_model"]
    normalization = normalization_digest(state)
    model = hydra.utils.instantiate(policy_cfg)
    model.load_state_dict(state, strict=True)
    return model.to(device).eval(), policy_cfg.shape_meta.obs, normalization


def load_language_encoder(path):
    import torch
    from transformers import AutoTokenizer, CLIPTextModelWithProjection

    tokenizer = AutoTokenizer.from_pretrained(path, local_files_only=True)
    encoder = CLIPTextModelWithProjection.from_pretrained(path, local_files_only=True).eval()

    @lru_cache(maxsize=64)
    @torch.inference_mode()
    def encode(text):
        tokens = tokenizer(text=text, add_special_tokens=True, padding="max_length",
                           return_attention_mask=True, return_tensors="pt")
        return encoder(**tokens).text_embeds[0].numpy()

    return encode


def policy_inputs(observation, fields, encode):
    from robomimic.utils.obs_utils import process_frame

    inputs = {"lang_emb": np.repeat(encode(observation[INSTRUCTION])[None], 2, axis=0)}
    for name, field in fields.items():
        if name == "lang_emb":
            continue
        value = observation[field.lerobot_keys[0]]
        if field.get("type") == "rgb":
            value = process_frame(value, channel_dim=3, scale=255.)
        inputs[name] = value
    return inputs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--checkpoint-digest")
    parser.add_argument("--normalization-digest")
    parser.add_argument("--backbone-digest")
    parser.add_argument("--healthcheck", action="store_true")
    args = parser.parse_args()
    if args.healthcheck:
        with urlopen("http://127.0.0.1:8000/healthz", timeout=3) as response:
            response.read()
        return
    if not all((args.weights, args.checkpoint_digest, args.normalization_digest, args.backbone_digest)):
        parser.error("--weights and all three asset digests are required")
    checkpoint, encoder = args.weights / CHECKPOINT, args.weights / "clip"
    if file_digest(checkpoint) != args.checkpoint_digest or tree_digest(encoder) != args.backbone_digest:
        raise ValueError("Diffusion Policy inference assets differ from the frozen registration")

    import torch
    from orbit_embodied.wire import serve_actions

    torch.set_num_threads(4)
    model, fields, normalization = load_policy(checkpoint, "cuda")
    if normalization != args.normalization_digest:
        raise ValueError("Diffusion Policy normalization digest mismatch")
    encode = load_language_encoder(encoder)
    torch.manual_seed(RANDOMNESS["initialSeed"])

    @torch.inference_mode()
    def infer(observation):
        inputs = {name: torch.from_numpy(value[None]).to(model.device)
                  for name, value in policy_inputs(observation, fields, encode).items()}
        return model.predict_action(inputs)["action"][0].cpu().numpy()

    metadata = {"actionSize": 12, "replanSteps": 8, "orbit": {
        "checkpointDigest": args.checkpoint_digest, "normalizationDigest": normalization,
        "backboneDigest": args.backbone_digest, "randomness": RANDOMNESS,
    }}
    asyncio.run(serve_actions(infer, metadata, "0.0.0.0", 8000))


if __name__ == "__main__":
    main()
