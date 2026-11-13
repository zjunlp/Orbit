"""Offline SmolVLA and MolmoAct2 serving for native LIBERO."""

import argparse
import asyncio
import json
from pathlib import Path
from urllib.request import urlopen

from orbit_embodied.assets import tree_digest
from orbit_embodied.binding import digest, file_digest


def normalization_digest(checkpoint, model):
    if model == "molmoact2":
        return file_digest(checkpoint / "norm_stats.json")
    files = sorted(checkpoint.glob("policy_*processor*"))
    if not files:
        raise ValueError("SmolVLA checkpoint requires its saved processors")
    return digest({file.name: file_digest(file) for file in files})


def smolvla(checkpoint):
    import torch
    from lerobot.configs.policies import PreTrainedConfig
    from lerobot.policies.factory import make_pre_post_processors
    from lerobot.policies.smolvla.modeling_smolvla import SmolVLAPolicy
    from orbit_embodied.openvla import libero_inputs

    processor = str(checkpoint / "processor")
    config = PreTrainedConfig.from_pretrained(checkpoint)
    config.vlm_model_name, config.load_vlm_weights = processor, False
    model = SmolVLAPolicy.from_pretrained(checkpoint, config=config, strict=True).eval()
    pre, post = make_pre_post_processors(config, str(checkpoint), preprocessor_overrides={
        "tokenizer_processor": {"tokenizer_name": processor},
    })

    @torch.inference_mode()
    def infer(observation):
        data = libero_inputs(observation)
        batch = {
            "observation.images.image": torch.from_numpy(data["full_image"]).permute(2, 0, 1).float() / 255,
            "observation.images.image2": torch.from_numpy(data["wrist_image"]).permute(2, 0, 1).float() / 255,
            "observation.state": torch.from_numpy(data["state"]).float(),
            "task": observation["instruction"],
        }
        return post(model.predict_action_chunk(pre(batch))[0]).detach().cpu().numpy()

    return infer


def molmoact2(checkpoint):
    import numpy as np
    import torch
    from transformers import AutoModelForImageTextToText, AutoProcessor
    from orbit_embodied.openvla import libero_inputs

    processor = AutoProcessor.from_pretrained(checkpoint, trust_remote_code=True, local_files_only=True)
    model = AutoModelForImageTextToText.from_pretrained(checkpoint, trust_remote_code=True, local_files_only=True,
                                                        dtype=torch.float32, device_map="cuda").eval()

    @torch.inference_mode()
    def infer(observation):
        data = libero_inputs(observation)
        result = model.predict_action(processor=processor, images=[data["full_image"], data["wrist_image"]],
                                      task=observation["instruction"], state=data["state"].astype(np.float32),
                                      norm_tag="libero", inference_action_mode="continuous",
                                      enable_depth_reasoning=False, num_steps=10, normalize_language=True,
                                      enable_cuda_graph=False)
        return result.actions[0].detach().cpu().numpy()

    return infer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=("smolvla", "molmoact2"))
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--checkpoint-digest")
    parser.add_argument("--normalization-digest")
    parser.add_argument("--healthcheck", action="store_true")
    args = parser.parse_args()
    if args.healthcheck:
        with urlopen("http://127.0.0.1:8000/healthz", timeout=3) as response:
            if response.status != 200:
                raise RuntimeError("policy is not ready")
        return
    if not all((args.model, args.checkpoint, args.checkpoint_digest, args.normalization_digest)):
        parser.error("model, checkpoint and both content digests are required")
    if tree_digest(args.checkpoint) != args.checkpoint_digest:
        raise ValueError("policy checkpoint content digest mismatch")
    if normalization_digest(args.checkpoint, args.model) != args.normalization_digest:
        raise ValueError("policy normalization content digest mismatch")

    import torch
    from orbit_embodied.wire import serve_actions

    load, replan_steps = (smolvla, 50) if args.model == "smolvla" else (molmoact2, 10)
    infer = load(args.checkpoint)
    torch.manual_seed(0)
    metadata = {"calibration": False, "actionSize": 7, "replanSteps": replan_steps, "orbit": {
        "checkpointDigest": args.checkpoint_digest, "normalizationDigest": args.normalization_digest,
        "randomness": {"backend": "torch", "initialSeed": 0, "scope": "service"},
    }}
    print(json.dumps(metadata), flush=True)
    asyncio.run(serve_actions(infer, metadata, "0.0.0.0", 8000))


if __name__ == "__main__":
    main()
