"""Serve the released optional-IDM Fast-WAM policy for LIBERO."""

import argparse
import asyncio
import os
from pathlib import Path

import numpy as np

from orbit_embodied.binding import digest, file_digest
from orbit_embodied.openpi import libero_gripper, libero_rgb, quaternion_to_axis_angle
from orbit_embodied.wire import serve_actions


CHECKPOINT = "libero_optional_idm_2cam224.pt"
STATS = "libero_optional_idm_2cam224_dataset_stats.json"
WAN = Path("Wan-AI/Wan2.2-TI2V-5B")
TOKENIZER = Path("Wan-AI/Wan2.1-T2V-1.3B/google/umt5-xxl")
BACKBONE_FILES = (WAN / "Wan2.2_VAE.pth", WAN / "models_t5_umt5-xxl-enc-bf16.pth",
                  *(TOKENIZER / name for name in ("special_tokens_map.json", "spiece.model",
                                                  "tokenizer.json", "tokenizer_config.json")))
REPLAN = 10
SEED = 42
MODES = ("first_frame", "idm")


def backbone_digest(root):
    return digest({str(path): file_digest(root / path) for path in BACKBONE_FILES})


def model_inputs(observation):
    from PIL import Image

    images = [np.asarray(Image.fromarray(libero_rgb(observation[key])).resize(
        (224, 224), resample=Image.Resampling.BILINEAR)) for key in ("front_rgb", "wrist_rgb")]
    state = np.concatenate((observation["eef_position"],
                            quaternion_to_axis_angle(observation["eef_quaternion"]),
                            observation["gripper_position"])).astype(np.float32)
    return np.concatenate(images, axis=1), state


def make_policy(root, mode):
    import torch
    from hydra import compose, initialize_config_dir
    from hydra.utils import instantiate

    from fastwam.datasets.lerobot.utils.normalizer import load_dataset_stats_from_json

    os.environ["DIFFSYNTH_MODEL_BASE_PATH"] = str(root / "backbone")
    with initialize_config_dir(config_dir="/opt/fastwam/configs", version_base="1.3"):
        config = compose(config_name="sim_libero", overrides=[
            "task=libero_optional_idm_2cam224_1e-4",
            # Use the original Wan release files in place of the converted mirror.
            "model.redirect_common_files=false",
        ])
    torch.manual_seed(SEED)
    model = instantiate(config.model, model_dtype=torch.bfloat16, device="cuda").eval()
    model.load_checkpoint(str(root / "policy" / CHECKPOINT))
    processor = instantiate(config.data.train.processor).eval()
    processor.set_normalizer_from_stats(load_dataset_stats_from_json(str(root / "policy" / STATS)))

    @torch.inference_mode()
    def infer(observation):
        rgb, state = model_inputs(observation)
        image = torch.tensor(rgb).permute(2, 0, 1).unsqueeze(0).to(device="cuda", dtype=model.torch_dtype)
        image = image * (2.0 / 255.0) - 1.0
        state_batch = processor.action_state_transform({"state": {"default": torch.from_numpy(state)[None]}})
        proprio = processor.normalizer.forward(state_batch)["state"]["default"]
        task = observation["instruction"]
        prompt = f"A video recorded from a robot's point of view executing the following instruction: {task}"
        result = model.infer_action(
            prompt=prompt, input_image=image, action_horizon=32, num_video_frames=9,
            negative_prompt="", text_cfg_scale=1.0, num_inference_steps=10, proprio=proprio,
            sigma_shift=1.0, seed=SEED, rand_device="cpu", tiled=False,
            compile_action_infer=False, action_infer_mode=mode,
        )
        action = result["action"].to(dtype=torch.float32, device="cpu")
        action = processor.normalizer.normalizers["action"]["default"].backward(action).numpy()
        if action.shape != (32, 7) or not np.isfinite(action).all():
            raise ValueError("Fast-WAM must return 32 finite LIBERO actions")
        return libero_gripper(action)

    return infer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", required=True, type=Path)
    parser.add_argument("--mode", required=True, choices=MODES)
    parser.add_argument("--checkpoint-digest", required=True)
    parser.add_argument("--normalization-digest", required=True)
    parser.add_argument("--backbone-digest", required=True)
    args = parser.parse_args()
    if (file_digest(args.weights / "policy" / CHECKPOINT) != args.checkpoint_digest
            or file_digest(args.weights / "policy" / STATS) != args.normalization_digest
            or backbone_digest(args.weights / "backbone") != args.backbone_digest):
        raise ValueError("Fast-WAM assets differ from the frozen registration")
    infer = make_policy(args.weights, args.mode)
    metadata = {"actionSize": 7, "replanSteps": REPLAN, "orbit": {
        "checkpointDigest": args.checkpoint_digest, "normalizationDigest": args.normalization_digest,
        "backboneDigest": args.backbone_digest, "randomness": {"backend": "stateless", "scope": "stateless"},
    }}
    asyncio.run(serve_actions(infer, metadata, "0.0.0.0", 8000))


if __name__ == "__main__":
    main()
