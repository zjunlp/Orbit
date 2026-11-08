"""Offline, content-checked OpenVLA-OFT inference using the official functions."""

import argparse
import asyncio
from http import HTTPStatus
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


async def serve(policy, metadata, host, port):
    from websockets.server import serve as websocket_serve
    from websockets.exceptions import ConnectionClosed
    from orbit_embodied.wire import pack, unpack

    async def health(path, _headers):
        if path == "/healthz":
            return HTTPStatus.OK, [("Content-Type", "text/plain")], b"OK\n"

    async def handler(connection):
        await connection.send(pack(metadata))
        try:
            async for message in connection:
                if not isinstance(message, bytes):
                    raise ValueError("policy requests must be binary")
                actions = policy(unpack(message))
                await connection.send(pack({"actions": actions}))
        except ConnectionClosed:
            return
        except Exception as exc:
            await connection.send(type(exc).__name__ + ": " + str(exc))
            await connection.close(code=1011, reason="policy inference failed")

    async with websocket_serve(handler, host, port, compression=None, max_size=64 * 1024 * 1024,
                              process_request=health):
        await asyncio.Future()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--checkpoint-digest")
    parser.add_argument("--normalization-digest")
    parser.add_argument("--unnorm-key")
    parser.add_argument("--decoding", choices=("continuous", "rlinf-discrete"), default="continuous")
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
    if tree_digest(args.checkpoint) != args.checkpoint_digest:
        raise ValueError("OpenVLA checkpoint content digest mismatch")
    if file_digest(args.checkpoint / "dataset_statistics.json") != args.normalization_digest:
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
    if (NUM_ACTIONS_CHUNK, ACTION_DIM, PROPRIO_DIM) != (8, 7, 8):
        raise ValueError("official model constants differ from the OFT LIBERO recipe")
    with tempfile.TemporaryDirectory(prefix="orbit-openvla-") as temporary:
        prepare_checkpoint(args.checkpoint, Path(temporary))
        discrete = args.decoding == "rlinf-discrete"
        cfg = SimpleNamespace(pretrained_checkpoint=temporary, load_in_8bit=False, load_in_4bit=False,
                              use_film=False, num_images_in_input=1 if discrete else 2, use_l1_regression=not discrete,
                              use_diffusion=False, use_proprio=not discrete, center_crop=not discrete,
                              unnorm_key=args.unnorm_key)
        model = official.get_vla(cfg)
        if cfg.unnorm_key not in model.norm_stats:
            raise ValueError("checkpoint lacks the configured normalization key")
        if discrete:
            from rlinf_openvla import predictor

            image_processor = official.PrismaticImageProcessor.from_pretrained(temporary, local_files_only=True)
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
        print(json.dumps(metadata), flush=True)
        asyncio.run(serve(infer, metadata, args.host, args.port))


if __name__ == "__main__":
    main()
