"""Serve RLinf pi0.5 checkpoints through the OpenPI Torch runtime."""

import argparse
import asyncio
import json
from pathlib import Path
from urllib.request import urlopen

from orbit_embodied.assets import tree_digest
from orbit_embodied.binding import file_digest


NORMALIZATION_DIR = "lerobot/metaworld_mt50"
CALVIN_NORMALIZATION_DIR = "InternRobotics/InternData-Calvin_ABC"


def inputs(observation):
    import numpy as np

    image = observation["front_rgb"]
    padding = np.zeros_like(image)
    return {"state": observation["state"], "prompt": observation["instruction"],
            "image": {"base_0_rgb": image, "left_wrist_0_rgb": padding, "right_wrist_0_rgb": padding},
            "image_mask": {"base_0_rgb": np.True_, "left_wrist_0_rgb": np.False_, "right_wrist_0_rgb": np.False_}}


def calvin_inputs(observation):
    import numpy as np

    data = inputs(observation)
    data["image"]["left_wrist_0_rgb"] = observation["wrist_rgb"]
    data["image_mask"]["left_wrist_0_rgb"] = np.True_
    return data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--recipe", choices=("metaworld", "calvin"), default="metaworld")
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
    if not all((args.checkpoint, args.checkpoint_digest, args.normalization_digest)):
        parser.error("checkpoint and both content digests are required")
    if tree_digest(args.checkpoint) != args.checkpoint_digest:
        raise ValueError("policy checkpoint content digest mismatch")
    calvin = args.recipe == "calvin"
    norm = args.checkpoint / (CALVIN_NORMALIZATION_DIR if calvin else NORMALIZATION_DIR)
    if file_digest(norm / "norm_stats.json") != args.normalization_digest:
        raise ValueError("policy normalization content digest mismatch")

    import torch
    from safetensors.torch import load_model
    from openpi import transforms
    from openpi.models.pi0_config import Pi0Config
    from openpi.models_pytorch.pi0_pytorch import PI0Pytorch
    from openpi.policies.policy import Policy
    from openpi.shared.normalize import load
    from openpi.training.config import ModelTransformFactory
    from orbit_embodied.wire import serve_actions

    config = Pi0Config(pi05=True, action_horizon=5, discrete_state_input=False)
    model = PI0Pytorch(config=config)
    load_model(model, str(args.checkpoint / "model.safetensors"))
    model.paligemma_with_expert.to_bfloat16_for_selected_params("bfloat16")
    stats = load(norm)
    processor = ModelTransformFactory()(config)
    prepare = calvin_inputs if calvin else inputs
    action_size = 7 if calvin else 4
    policy = Policy(model, transforms=[prepare, transforms.Normalize(stats, use_quantiles=True), *processor.inputs],
                    output_transforms=[*processor.outputs, transforms.Unnormalize(stats, use_quantiles=True)],
                    sample_kwargs={"num_steps": 5}, is_pytorch=True, pytorch_device="cuda")
    torch.manual_seed(0)

    @torch.inference_mode()
    def infer(observation):
        actions = policy.infer(observation)["actions"][:, :action_size]
        if calvin:
            import numpy as np

            if not np.isfinite(actions).all():
                raise ValueError("CALVIN policy returned non-finite actions")
            actions[:, -1] = np.where(actions[:, -1] > 0, 1, -1)
        return actions

    metadata = {"calibration": False, "actionSize": action_size, "replanSteps": 5, "orbit": {
        "checkpointDigest": args.checkpoint_digest, "normalizationDigest": args.normalization_digest,
        "randomness": {"backend": "torch", "initialSeed": 0, "scope": "service"},
    }}
    print(json.dumps(metadata), flush=True)
    asyncio.run(serve_actions(infer, metadata, "0.0.0.0", 8000))


if __name__ == "__main__":
    main()
