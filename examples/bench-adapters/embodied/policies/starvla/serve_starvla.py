"""Serve StarVLA QwenGR00T with the official WidowX action ensemble."""

import argparse
import asyncio
from pathlib import Path

import numpy as np

from orbit_embodied.assets import tree_digest
from orbit_embodied.binding import file_digest


CHECKPOINT = "policy/checkpoints/steps_20000_pytorch_model.pt"
STATS = "policy/dataset_statistics.json"
UNNORM = "oxe_bridge"
BACKBONE = "Qwen3-VL-4B-Instruct"


def native_action(action):
    from transforms3d.euler import euler2axangle

    axis, angle = euler2axangle(*np.asarray(action[3:6], dtype=np.float64))
    return np.concatenate((action[:3], axis * angle, [1.0 if action[6] > 0.5 else -1.0, 0.0]))[None, :]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--checkpoint-digest", required=True)
    parser.add_argument("--normalization-digest", required=True)
    args = parser.parse_args()
    if (tree_digest(args.weights) != args.checkpoint_digest
            or file_digest(args.weights / STATS) != args.normalization_digest):
        raise ValueError("StarVLA assets differ from the frozen registration")

    from deployment.model_server.policy_wrapper import PolicyServerWrapper
    from deployment.model_server.seed_utils import set_seed_everywhere
    from examples.simBenchmarks.SimplerEnv.eval_files.adaptive_ensemble import AdaptiveEnsembler
    from orbit_embodied.wire import serve_actions

    set_seed_everywhere(0)
    wrapper = PolicyServerWrapper(str(args.weights / CHECKPOINT), device="cuda", use_bf16=True,
                                  unnorm_key=UNNORM, config_overrides=[
                                      "framework.qwenvl.base_vlm=" + str(args.weights / BACKBONE),
                                  ])
    if wrapper.metadata["action_chunk_size"] != 16:
        raise ValueError("expected the released 16-step StarVLA action head")
    ensemble = AdaptiveEnsembler(7, 0.1)
    instruction = None

    def reset():
        nonlocal instruction
        instruction = None
        ensemble.reset()

    def infer(observation):
        nonlocal instruction
        prompt = observation["annotation.human.action.task_description"]
        if prompt != instruction:
            ensemble.reset()
            instruction = prompt
        payload = [{"image": [observation["video.image_0"]], "lang": prompt}]
        chunk = np.asarray(wrapper.predict_action(payload, unnorm_key=UNNORM, do_sample=False,
                                                  use_ddim=True, num_ddim_steps=10)["actions"])
        if chunk.shape != (1, 16, 7) or not np.isfinite(chunk).all():
            raise ValueError("expected a finite StarVLA WidowX action chunk")
        return native_action(ensemble.ensemble_action(chunk[0]))

    metadata = {"actionSize": 8, "replanSteps": 1, "unnormKey": UNNORM, "orbit": {
        "checkpointDigest": args.checkpoint_digest, "normalizationDigest": args.normalization_digest,
        "randomness": {"backend": "torch", "initialSeed": 0, "scope": "service"},
    }}
    asyncio.run(serve_actions(infer, metadata, "0.0.0.0", 8000, reset=reset))


if __name__ == "__main__":
    main()
