"""Serve the released RoboMME no-history pi0.5 checkpoint."""

import os
from pathlib import Path


CHECKPOINT = Path("pi05_baseline/79999")
TOKENIZER = Path("tokenizer/paligemma_tokenizer.model")
ASSETS = {
    "checkpointDigest": ((CHECKPOINT / "params").as_posix(),),
    "normalizationDigest": ((CHECKPOINT / "assets/robomme/norm_stats.json").as_posix(),),
    "backboneDigest": (TOKENIZER.as_posix(),),
}
RANDOMNESS = {"backend": "jax", "initialKey": 0, "scope": "episode"}


def build(weights):
    from shutil import copyfile
    from tempfile import mkdtemp

    from mme_vla_suite.policies.policy_config import create_trained_policy
    from mme_vla_suite.training.config import get_config

    checkpoint = weights / CHECKPOINT
    if (checkpoint.parent / "history_config.txt").exists():
        raise ValueError("the released RoboMME baseline must run with history disabled")
    cache = Path(mkdtemp(prefix="orbit-robomme-pi05-"))
    tokenizer = cache / "big_vision/paligemma_tokenizer.model"
    tokenizer.parent.mkdir()
    # OpenPI resolves the cached path before checking it belongs to this cache.
    copyfile(weights / TOKENIZER, tokenizer)
    os.environ["OPENPI_DATA_HOME"] = str(cache)
    policy = create_trained_policy(get_config("pi05_baseline"), checkpoint, seed=0)

    def infer(observation):
        observation = {"observation/image": observation["front_rgb"],
                       "observation/wrist_image": observation["wrist_rgb"],
                       "observation/state": observation["joint_state"],
                       "prompt": observation["instruction"]}
        return policy.infer(observation)["actions"]

    return infer, policy.reset


if __name__ == "__main__":
    from orbit_embodied.wire import serve_frozen_actions

    serve_frozen_actions(build, ASSETS, 8, 16, RANDOMNESS, action_count=20)
