"""Serve the native OpenWAM VLABench checkpoint using Orbit's policy wire."""

import argparse
import asyncio
from pathlib import Path
from urllib.request import urlopen

import numpy as np

from orbit_embodied.assets import tree_digest
from orbit_embodied.binding import file_digest
from orbit_embodied.wire import serve_actions


def action_for(server, observation):
    from benchmarks.utils import client, eef10_to_vlabench_ee, resize_for_lshape_slot, vlabench_obs_to_eef10

    def camera(field, slot):
        return client.encode_numpy_b64(resize_for_lshape_slot(observation[field], slot))

    base = observation["robot_base"]
    prompt = observation["instruction"]
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("OpenWAM expects a nonempty VLABench instruction")
    payload = client.build_payload(
        head=camera("front_rgb", "head_camera"),
        left_wrist=camera("wrist_rgb", "left_wrist_camera"),
        right_wrist=camera("right_rgb", "right_wrist_camera"),
        prompt=prompt, state=vlabench_obs_to_eef10(observation["ee_state"], base).tolist(),
    )
    native = np.asarray(server.predict(payload)["action"], dtype=np.float32)
    if native.shape != (10,) or not np.isfinite(native).all():
        raise ValueError("OpenWAM must return a finite VLABench EEF10 action")
    return np.concatenate(eef10_to_vlabench_ee(native, base))[None, :]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--checkpoint-digest")
    parser.add_argument("--normalization-digest")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--healthcheck", action="store_true")
    args = parser.parse_args()
    if args.healthcheck:
        with urlopen(f"http://127.0.0.1:{args.port}/healthz", timeout=3) as response:
            if response.read() != b"OK\n":
                raise RuntimeError("OpenWAM is not ready")
        return
    if not all((args.checkpoint, args.checkpoint_digest, args.normalization_digest)):
        parser.error("checkpoint and both content digests are required")
    if tree_digest(args.checkpoint) != args.checkpoint_digest:
        raise ValueError("OpenWAM checkpoint content digest mismatch")
    if file_digest(args.checkpoint / "normalization_stats.npy") != args.normalization_digest:
        raise ValueError("OpenWAM normalization content digest mismatch")

    from omegaconf import OmegaConf
    from openwam.deploy.server import build_server_from_config

    training = OmegaConf.load(args.checkpoint / "config.yaml")
    if training.dataloader.type != "vlabench" or list(training.dataloader.unify_action_map) != ["0-9"]:
        raise ValueError("OpenWAM expects the VLABench EEF10 checkpoint")
    deploy = OmegaConf.load(Path("/opt/openwam/configs/deploy.yaml"))
    # Match the reference sync executor with eager inference.
    deploy.optimization.compile.enabled = False
    server = build_server_from_config(deploy, str(args.checkpoint), device="cuda:0",
                                      ckpt_name="checkpoint_step_6000.safetensors")
    metadata = {"replanSteps": 1, "actionSize": 8, "orbit": {
        "checkpointDigest": args.checkpoint_digest, "normalizationDigest": args.normalization_digest,
        "randomness": {"backend": "stateless", "scope": "stateless"},
    }}
    try:
        asyncio.run(serve_actions(lambda obs: action_for(server, obs), metadata,
                                  "0.0.0.0", args.port, reset=server.reset))
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
