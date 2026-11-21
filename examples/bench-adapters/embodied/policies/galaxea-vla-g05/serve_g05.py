"""Serve the LeRobot release of Galaxea G0.5 for native RoboTwin joint control."""

ASSETS = {
    "checkpointDigest": ("config.json", "model.safetensors"),
    "backboneDigest": ("action_tokenizer.safetensors", "hf_processor"),
    "normalizationDigest": (
        "policy_preprocessor.json", "policy_postprocessor.json",
        "policy_preprocessor_step_5_normalizer_processor.safetensors",
        "policy_postprocessor_step_0_unnormalizer_processor.safetensors",
    ),
}
RANDOMNESS = {"backend": "torch", "initialSeed": 0, "scope": "service"}
CAMERAS = ("head_camera", "left_camera", "right_camera")
JOINTS = 14
POLICY_ACTION_DIM = 20
HORIZON = 32
REPLAN_STEPS = 8


def model_inputs(observation):
    import torch

    return {
        "observation.state": torch.tensor(observation["joint_state"], dtype=torch.float32),
        "task": observation["instruction"],
        **{"observation.images." + camera:
           torch.from_numpy(observation[camera].copy()).permute(2, 0, 1)
           for camera in CAMERAS},
    }


def build(weights):
    import torch
    from lerobot.policies.g05.configuration_g05 import G05Config
    from lerobot.policies.g05.modeling_g05 import G05Policy
    from lerobot.policies.g05.processor_g05 import make_g05_pre_post_processors_from_pretrained
    from orbit_embodied import EpisodeFailure

    config = G05Config.from_pretrained(weights, local_files_only=True)
    if (config.embodiment, config.action_head, config.runtime_system, config.n_obs_steps,
            config.raw_state_dim, config.raw_action_dim, config.policy_action_dim,
            config.chunk_size, config.n_action_steps) != (
            "robotwin", "flow", "system1", 1, JOINTS, JOINTS, POLICY_ACTION_DIM, HORIZON, REPLAN_STEPS):
        raise ValueError("expected the LeRobot G0.5 RoboTwin System 1 checkpoint")
    config.device = "cuda"
    pre, post = make_g05_pre_post_processors_from_pretrained(
        config, str(weights), preprocessor_overrides={"device_processor": {"device": config.device}},
    )
    model = G05Policy.from_pretrained(weights, config=config, local_files_only=True, strict=True)
    torch.manual_seed(RANDOMNESS["initialSeed"])

    def reset():
        model.reset()
        pre.reset()
        post.reset()

    @torch.inference_mode()
    def infer(observation):
        prediction = model.predict_action_chunk(pre(model_inputs(observation)))
        if prediction.shape != (1, HORIZON, POLICY_ACTION_DIM):
            raise EpisodeFailure("policy_act", "G0.5 returned a malformed raw action prediction",
                                 rejected_actions=prediction.detach().cpu().float().numpy())
        if not torch.isfinite(prediction).all().item():
            raise EpisodeFailure("policy_act", "G0.5 returned non-finite raw actions",
                                 rejected_actions=prediction.detach().cpu().float().numpy())
        # Unnormalize the full horizon so that the saved per-timestep statistics line up.
        actions = post(prediction).detach().cpu().float().numpy()
        if actions.shape != (1, HORIZON, JOINTS):
            raise EpisodeFailure("policy_act", "G0.5 returned a malformed RoboTwin action chunk",
                                 rejected_actions=actions)
        return actions[0, :REPLAN_STEPS]

    return infer, reset


if __name__ == "__main__":
    from orbit_embodied.wire import serve_frozen_actions

    serve_frozen_actions(build, ASSETS, JOINTS, REPLAN_STEPS, RANDOMNESS)
