"""Offline, content-checked OpenVLA-OFT inference using the official functions."""

import argparse
import asyncio
import json
import os
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace


def prepare_checkpoint(checkpoint, destination):
    for source in checkpoint.resolve().iterdir():
        if source.is_dir():
            raise ValueError("expected a flat, merged OFT inference checkpoint")
        if source.suffix in (".safetensors", ".pt"):
            (destination / source.name).symlink_to(source)
        else:
            shutil.copy2(source, destination / source.name)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--checkpoint-digest")
    parser.add_argument("--normalization-digest")
    parser.add_argument("--unnorm-key")
    parser.add_argument("--decoding", choices=("continuous", "rlinf-discrete", "rlinf-maniskill"), default="continuous")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--healthcheck", action="store_true")
    args = parser.parse_args()
    if args.healthcheck:
        from urllib.request import urlopen
        with urlopen("http://127.0.0.1:" + str(args.port) + "/healthz", timeout=3) as response:
            if response.status != 200:
                raise RuntimeError("OpenVLA is not ready")
        return
    if not all((args.checkpoint, args.checkpoint_digest, args.normalization_digest, args.unnorm_key)):
        parser.error("checkpoint, normalization key and both content digests are required")
    from orbit_embodied.assets import tree_digest
    from orbit_embodied.evidence import file_digest
    from orbit_embodied.wire import serve_actions
    if tree_digest(args.checkpoint) != args.checkpoint_digest:
        raise ValueError("OpenVLA checkpoint content digest mismatch")
    maniskill = args.decoding == "rlinf-maniskill"
    stats_file = "config.json" if maniskill else "dataset_statistics.json"
    if file_digest(args.checkpoint / stats_file) != args.normalization_digest:
        raise ValueError("OpenVLA normalization content digest mismatch")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    import numpy as np
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError("OpenVLA-OFT policy requires its leased CUDA device")
    import tensorflow as tf
    tf.config.set_visible_devices([], "GPU")
    from experiments.robot import openvla_utils as official
    from experiments.robot.robot_utils import set_seed_everywhere
    from orbit_embodied.openvla import libero_inputs
    from prismatic.vla.constants import ACTION_DIM, NUM_ACTIONS_CHUNK, PROPRIO_DIM
    # The RLinf ManiSkill decoder sets its own chunk length and uses no proprioception.
    if ACTION_DIM != 7 or (not maniskill and (NUM_ACTIONS_CHUNK, PROPRIO_DIM) != (8, 8)):
        raise ValueError("official model constants differ from the selected OFT recipe")
    with tempfile.TemporaryDirectory(prefix="orbit-openvla-") as temporary:
        prepare_checkpoint(args.checkpoint, Path(temporary))
        discrete = args.decoding != "continuous"
        cfg = SimpleNamespace(pretrained_checkpoint=temporary, load_in_8bit=False, load_in_4bit=False,
                              use_film=False, num_images_in_input=1 if discrete else 2, use_l1_regression=not discrete,
                              use_diffusion=False, use_proprio=not discrete, center_crop=not discrete,
                              unnorm_key=args.unnorm_key)
        model = official.get_vla(cfg)
        if maniskill:
            model.norm_stats[cfg.unnorm_key] = json.loads((args.checkpoint / stats_file).read_text())["norm_stats"][cfg.unnorm_key]
        if cfg.unnorm_key not in model.norm_stats:
            raise ValueError("checkpoint lacks the configured normalization key")
        if discrete:
            from rlinf_openvla import predictor

            image_processor = official.PrismaticImageProcessor.from_pretrained(temporary, local_files_only=True)
            if maniskill:
                predict = predictor(model, image_processor, temporary, cfg.unnorm_key, temperature=0.6,
                                    prompt_length=30, flip_camera=False)

                def infer(observation):
                    actions = predict(observation)
                    if not np.isfinite(actions).all():
                        raise ValueError("OFT returned non-finite actions")
                    actions[:, -1] = 2 * (actions[:, -1] > 0.5) - 1
                    return actions
            else:
                infer = predictor(model, image_processor, temporary, cfg.unnorm_key)
        else:
            processor = official.get_processor(cfg)
            projector = official.get_proprio_projector(cfg, model.llm_dim, proprio_dim=8)
            action_head = official.get_action_head(cfg, model.llm_dim)

            def infer(observation):
                inputs = libero_inputs(observation)
                return np.asarray(official.get_vla_action(cfg, model, processor, inputs, observation["instruction"],
                                                         action_head=action_head, proprio_projector=projector))
        set_seed_everywhere(0)

        metadata = {"calibration": False, "ioAdapter": "libero-native", "actionChunkSize": 8, "unnormKey": cfg.unnorm_key,
                    "runtime": {"torch": torch.__version__, "cuda": torch.version.cuda}, "orbit": {
                        "checkpointDigest": args.checkpoint_digest, "normalizationDigest": args.normalization_digest,
                        "randomness": {"backend": "torch", "initialSeed": 0, "scope": "service"}}}
        if maniskill:
            metadata.update(ioAdapter="maniskill3", actionSize=7, replanSteps=8)
        print(json.dumps(metadata), flush=True)
        asyncio.run(serve_actions(infer, metadata, args.host, args.port))


if __name__ == "__main__":
    main()
