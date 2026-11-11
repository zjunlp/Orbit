"""Audit-only paired policy servers: shared immutable model, independent initial JAX streams."""

import argparse
import asyncio
import copy
from pathlib import Path

from orbit_embodied.assets import tree_digest


def independent_policies(policy):
    # Policy.infer replaces its immutable JAX key; weights and the compiled sampler are shared.
    return copy.copy(policy), copy.copy(policy)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--checkpoint-digest", required=True)
    parser.add_argument("--normalization-digest", required=True)
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    if tree_digest(args.checkpoint) != args.checkpoint_digest or tree_digest(args.checkpoint / "assets") != args.normalization_digest:
        raise ValueError("paired policy assets differ from the frozen comparison")
    import jax
    from openpi.policies.policy_config import create_trained_policy
    from openpi.serving.websocket_policy_server import WebsocketPolicyServer
    from openpi.training.config import get_config

    policy = create_trained_policy(get_config(args.config), args.checkpoint)
    if policy._is_pytorch_model or jax.default_backend() != "gpu":
        raise ValueError("paired reference comparison requires the pinned JAX CUDA runtime")
    reference, candidate = independent_policies(policy)
    servers = []
    for index, (branch, instance) in enumerate((("reference", reference), ("candidate", candidate))):
        metadata = {**instance.metadata, "orbit": {
            "checkpointDigest": args.checkpoint_digest, "normalizationDigest": args.normalization_digest,
            "randomness": {"backend": "jax", "initialKey": 0, "scope": "service"},
        }, "comparison": {"branch": branch, "independentStream": True, "sharedCompiledModel": True}}
        servers.append(WebsocketPolicyServer(instance, host="0.0.0.0", port=args.port + index, metadata=metadata))

    async def serve():
        await asyncio.gather(*(server.run() for server in servers))

    asyncio.run(serve())


if __name__ == "__main__":
    main()
