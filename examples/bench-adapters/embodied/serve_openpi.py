"""Model-side OpenPI launcher: verify assets and expose identity in the native handshake."""

import argparse
from dataclasses import replace
from pathlib import Path

from orbit_embodied.assets import tree_digest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--checkpoint-digest", required=True)
    parser.add_argument("--normalization-digest", required=True)
    parser.add_argument("--robocasa-inference", action="store_true")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    checkpoint = Path(args.checkpoint)
    if tree_digest(checkpoint) != args.checkpoint_digest:
        raise ValueError("checkpoint content digest mismatch")
    if tree_digest(checkpoint / "assets") != args.normalization_digest:
        raise ValueError("normalization content digest mismatch")
    from openpi.policies.policy_config import create_trained_policy
    from openpi.serving.websocket_policy_server import WebsocketPolicyServer
    from openpi.training.config import get_config

    config = get_config(args.config)
    if args.robocasa_inference:
        from openpi.training.config import LeRobotRobocasaDataConfig

        if not isinstance(config.data, LeRobotRobocasaDataConfig):
            raise ValueError("expected the RoboCasa OpenPI training recipe")
        # Serving loads normalization from the checkpoint after building the data transforms.
        config = replace(config, data=replace(config.data, data_dirs=None))
    policy = create_trained_policy(config, checkpoint)
    if getattr(policy, "_is_pytorch_model", False):
        raise ValueError("this reference launcher supports OpenPI JAX policies only")
    metadata = {**policy.metadata, "orbit": {
        "checkpointDigest": args.checkpoint_digest, "normalizationDigest": args.normalization_digest,
        "randomness": {"backend": "jax", "initialKey": 0, "scope": "service"},
    }}
    WebsocketPolicyServer(policy, host="0.0.0.0", port=args.port, metadata=metadata).serve_forever()


if __name__ == "__main__":
    main()
