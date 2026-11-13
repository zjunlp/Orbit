"""Serve the LingBot-VLA 2.0 RoboTwin joint-control checkpoint through LeRobot."""

import argparse
import asyncio
from pathlib import Path

import numpy as np

from orbit_embodied.binding import digest, file_digest


CHUNK = 50
JOINTS = 14
MODEL_SHA256 = "sha256:3c7f2225969d18880a2063088799078133d6006b82d725903da45af33e0659c2"
PROCESSOR_SHA256 = "sha256:f47f9d42ed36d373b88e633640a2c167a41b33a20681ad20d2cbe646c24e57fe"
RANDOMNESS = {"backend": "torch", "initialSeed": 0, "scope": "service"}
CAMERAS = {
    "head_camera": "cam_high",
    "left_camera": "cam_left_wrist",
    "right_camera": "cam_right_wrist",
}
PROCESSOR_FILES = (
    "qwen/config.json",
    "policy/config.json",
    "policy/policy_preprocessor.json",
    "policy/policy_postprocessor.json",
    "policy/policy_preprocessor_step_3_normalizer_processor.safetensors",
    "policy/policy_postprocessor_step_1_unnormalizer_processor.safetensors",
    "policy/image_processor/preprocessor_config.json",
    "policy/tokenizer/tokenizer.json",
    "policy/tokenizer/tokenizer_config.json",
    "policy/tokenizer/chat_template.jinja",
    "policy/chat_template_tokenizer/tokenizer.json",
    "policy/chat_template_tokenizer/tokenizer_config.json",
    "policy/chat_template_tokenizer/chat_template.jinja",
)


def asset_digests(root):
    checkpoint = file_digest(root / "policy/model.safetensors")
    if checkpoint != MODEL_SHA256:
        raise ValueError("LingBot-VLA 2.0 requires the published RoboTwin checkpoint")
    processors = digest({name: file_digest(root / name) for name in PROCESSOR_FILES})
    if processors != PROCESSOR_SHA256:
        raise ValueError("LingBot-VLA 2.0 requires the published RoboTwin processors and Qwen3-VL configuration")
    return checkpoint, processors


def model_inputs(observation):
    import torch

    batch = {
        "observation.state": torch.tensor(observation["joint_state"], dtype=torch.float32),
        "task": observation["instruction"],
    }
    for field, camera in CAMERAS.items():
        image = np.asarray(observation[field])
        if image.dtype != np.uint8 or image.ndim != 3 or image.shape[-1] != 3:
            raise ValueError("expected a RoboTwin RGB uint8 camera: " + field)
        batch["observation.images." + camera] = torch.tensor(image).permute(2, 0, 1).float() / 255
    return batch


def load_processors(checkpoint, config, device):
    from lerobot.policies.lingbot_vla_v2.processor_lingbot_vla_v2 import (
        make_lingbot_vla_v2_pre_post_processors_from_pretrained,
    )

    return make_lingbot_vla_v2_pre_post_processors_from_pretrained(
        config, str(checkpoint), preprocessor_overrides={"device_processor": {"device": device}},
    )


def native_actions(actions):
    if tuple(actions.shape) != (1, CHUNK, JOINTS):
        raise ValueError("LingBot-VLA 2.0 must return fifty RoboTwin joint targets")
    values = actions[0].detach().cpu().float().numpy()
    if not np.isfinite(values).all():
        raise ValueError("LingBot-VLA 2.0 returned non-finite RoboTwin joint targets")
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--checkpoint-digest", required=True)
    parser.add_argument("--normalization-digest", required=True)
    args = parser.parse_args()
    if asset_digests(args.weights) != (args.checkpoint_digest, args.normalization_digest):
        raise ValueError("LingBot-VLA 2.0 assets differ from the frozen registration")

    import torch
    from lerobot.policies.lingbot_vla_v2.configuration_lingbot_vla_v2 import LingbotVLAV2Config
    from lerobot.policies.lingbot_vla_v2.modeling_lingbot_vla_v2 import LingbotVLAV2Policy
    from orbit_embodied.wire import serve_actions

    checkpoint = args.weights / "policy"
    config = LingbotVLAV2Config.from_pretrained(checkpoint, local_files_only=True)
    config.tokenizer_path = str(args.weights / "qwen")
    config.device = "cuda"
    pre, post = load_processors(checkpoint, config, config.device)
    model = LingbotVLAV2Policy.from_pretrained(checkpoint, config=config, strict=True)
    torch.manual_seed(RANDOMNESS["initialSeed"])

    def reset():
        model.reset()
        pre.reset()
        post.reset()

    @torch.inference_mode()
    def infer(observation):
        return native_actions(post(model.predict_action_chunk(pre(model_inputs(observation)))))

    metadata = {"actionSize": JOINTS, "replanSteps": CHUNK, "orbit": {
        "checkpointDigest": args.checkpoint_digest, "normalizationDigest": args.normalization_digest,
        "randomness": RANDOMNESS,
    }}
    asyncio.run(serve_actions(infer, metadata, "0.0.0.0", 8000, reset=reset))


if __name__ == "__main__":
    main()
