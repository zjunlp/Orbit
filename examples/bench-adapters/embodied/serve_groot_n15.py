"""Serve the pinned RoboCasa GR00T N1.5 policy over Orbit's GR00T wire."""

import argparse
import json
from pathlib import Path
import random
import traceback

import zmq

from orbit_embodied.assets import tree_digest
from orbit_embodied.evidence import file_digest
from orbit_embodied.wire import pack, unpack


def healthcheck(port):
    with zmq.Context() as context, context.socket(zmq.REQ) as socket:
        socket.setsockopt(zmq.LINGER, 0)
        socket.setsockopt(zmq.RCVTIMEO, 3000)
        socket.connect(f"tcp://127.0.0.1:{port}")
        socket.send(pack({"endpoint": "ping"}))
        if unpack(socket.recv()).get("status") != "ok":
            raise RuntimeError("policy is not ready")


def serve(policy, identity, port):
    modalities = {}
    for key, value in policy.get_modality_config().items():
        modalities[key] = {
            "delta_indices": list(value.delta_indices),
            "modality_keys": [name.removeprefix(key + ".") for name in value.modality_keys],
        }
    endpoints = {
        "ping": lambda _: {"status": "ok"},
        "orbit_identity": lambda _: identity,
        "get_modality_config": lambda _: modalities,
        # The upstream policy has no episode-local state to reset. Its RNG stays service-scoped.
        "reset": lambda _: {},
        "get_action": lambda data: (policy.get_action(data["observation"]), {}),
    }
    with zmq.Context() as context, context.socket(zmq.REP) as socket:
        socket.setsockopt(zmq.LINGER, 0)
        socket.setsockopt(zmq.MAXMSGSIZE, 64 * 1024 * 1024)
        socket.bind(f"tcp://0.0.0.0:{port}")
        while True:
            message = socket.recv()
            try:
                request = unpack(message)
                response = pack(endpoints[request["endpoint"]](request.get("data")))
            except Exception as exc:
                traceback.print_exc()
                response = pack({"error": str(exc)})
            socket.send(response)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--checkpoint-digest")
    parser.add_argument("--normalization-digest")
    parser.add_argument("--backbone-digest")
    parser.add_argument("--port", type=int, default=5555)
    parser.add_argument("--healthcheck", action="store_true")
    args = parser.parse_args()
    if args.healthcheck:
        healthcheck(args.port)
        return
    if not all((args.checkpoint, args.checkpoint_digest, args.normalization_digest, args.backbone_digest)):
        parser.error("checkpoint and all content digests are required")
    if tree_digest(args.checkpoint) != args.checkpoint_digest:
        raise ValueError("GR00T N1.5 checkpoint content digest mismatch")
    if file_digest(args.checkpoint / "experiment_cfg/metadata.json") != args.normalization_digest:
        raise ValueError("GR00T N1.5 normalization content digest mismatch")

    import numpy as np
    import torch
    from gr00t.experiment.data_config import DATA_CONFIG_MAP
    from gr00t.model.backbone.eagle_backbone import DEFAULT_EAGLE_PATH
    from gr00t.model.policy import Gr00tPolicy

    if tree_digest(DEFAULT_EAGLE_PATH) != args.backbone_digest:
        raise ValueError("GR00T N1.5 bundled Eagle assets differ from the frozen source")
    if not torch.cuda.is_available():
        raise RuntimeError("GR00T N1.5 requires CUDA")
    data = DATA_CONFIG_MAP["panda_omron"]
    policy = Gr00tPolicy(model_path=str(args.checkpoint), embodiment_tag="new_embodiment",
                         modality_config=data.modality_config(), modality_transform=data.transform(),
                         denoising_steps=4, device="cuda")
    random.seed(0)
    np.random.seed(0)
    torch.manual_seed(0)
    identity = {"calibration": False, "runtime": {"torch": torch.__version__, "cuda": torch.version.cuda},
                "orbit": {"checkpointDigest": args.checkpoint_digest,
                          "normalizationDigest": args.normalization_digest, "backboneDigest": args.backbone_digest,
                          "randomness": {"backend": "torch", "initialSeed": 0, "scope": "service"}}}
    print(json.dumps(identity), flush=True)
    serve(policy, identity, args.port)


if __name__ == "__main__":
    main()
