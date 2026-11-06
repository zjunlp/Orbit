"""Audited GR00T policy with its official server and an Orbit identity endpoint."""

import argparse
import json
import os
from pathlib import Path
import random
import tempfile


def prepare_checkpoint(checkpoint, cache, destination):
    checkpoint, cache = checkpoint.resolve(), cache.resolve()
    repository = "nvidia/Cosmos-Reason2-2B"
    cached = cache / "models--nvidia--Cosmos-Reason2-2B"
    revision = (cached / "refs/main").read_text().strip()
    if len(revision) != 40 or any(char not in "0123456789abcdef" for char in revision):
        raise ValueError("invalid pinned backbone cache reference")
    snapshot = cached / "snapshots" / revision
    if not snapshot.is_dir():
        raise ValueError("missing pinned backbone snapshot")
    alias = destination / "nvidia/Cosmos-Reason2-2B"
    alias.parent.mkdir()
    alias.symlink_to(snapshot, target_is_directory=True)
    for source in checkpoint.iterdir():
        if source.name in ("config.json", "processor_config.json"):
            value = json.loads(source.read_text())
            target = value if source.name == "config.json" else value["processor_kwargs"]
            if target.get("model_name", repository) != repository:
                raise ValueError("unexpected GR00T backbone reference")
            target["model_name"] = str(alias)
            (destination / source.name).write_text(json.dumps(value))
        else:
            (destination / source.name).symlink_to(source)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--backbone-cache", type=Path)
    parser.add_argument("--checkpoint-digest")
    parser.add_argument("--normalization-digest")
    parser.add_argument("--backbone-digest")
    parser.add_argument("--embodiment")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=5555)
    parser.add_argument("--healthcheck", action="store_true")
    args = parser.parse_args()
    if args.healthcheck:
        import zmq
        from orbit_embodied.groot import pack, unpack
        with zmq.Context() as context, context.socket(zmq.REQ) as socket:
            socket.setsockopt(zmq.LINGER, 0)
            socket.setsockopt(zmq.RCVTIMEO, 3000)
            socket.setsockopt(zmq.SNDTIMEO, 3000)
            socket.connect("tcp://127.0.0.1:" + str(args.port))
            socket.send(pack({"endpoint": "ping"}))
            if unpack(socket.recv()).get("status") != "ok":
                raise RuntimeError("policy is not ready")
        return
    if not all((args.checkpoint, args.backbone_cache, args.embodiment,
                args.checkpoint_digest, args.normalization_digest, args.backbone_digest)):
        parser.error("checkpoint, backbone cache, embodiment and all content digests are required")
    from orbit_embodied.assets import tree_digest
    from orbit_embodied.evidence import file_digest
    if tree_digest(args.checkpoint) != args.checkpoint_digest:
        raise ValueError("GR00T checkpoint content digest mismatch")
    if file_digest(args.checkpoint / "statistics.json") != args.normalization_digest:
        raise ValueError("GR00T normalization content digest mismatch")
    if tree_digest(args.backbone_cache) != args.backbone_digest:
        raise ValueError("GR00T backbone cache content digest mismatch")
    os.environ["HF_HUB_CACHE"] = str(args.backbone_cache)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    from gr00t.policy.gr00t_policy import Gr00tPolicy, Gr00tSimPolicyWrapper
    from gr00t.policy.server_client import PolicyServer
    import numpy as np
    import torch
    with tempfile.TemporaryDirectory(prefix="orbit-groot-") as temporary:
        prepare_checkpoint(args.checkpoint, args.backbone_cache, Path(temporary))
        policy = Gr00tSimPolicyWrapper(Gr00tPolicy(args.embodiment, temporary, device="cuda", strict=True))
        random.seed(0)
        np.random.seed(0)
        torch.manual_seed(0)
        torch.cuda.manual_seed_all(0)
        identity = {"calibration": False, "assetResolution": "local-snapshot-metadata/1", "runtime": {
            "torch": torch.__version__, "cuda": torch.version.cuda}, "orbit": {
            "checkpointDigest": args.checkpoint_digest, "normalizationDigest": args.normalization_digest,
            "backboneDigest": args.backbone_digest,
            "randomness": {"backend": "torch", "initialSeed": 0, "scope": "service"}}}
        print(json.dumps(identity), flush=True)
        with PolicyServer(policy, host=args.host, port=args.port) as server:
            server.register_endpoint("orbit_identity", lambda: identity, requires_input=False)
            server.run()


if __name__ == "__main__":
    main()
