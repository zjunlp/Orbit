"""Serve the released Motus video-action policy for RoboTwin."""

from pathlib import Path

from orbit_embodied.binding import file_digest


ASSETS = {
    "checkpointDigest": ("robotwin2/mp_rank_00_model_states.pt",),
    "backboneDigest": (
        "wan/config.json", "wan/Wan2.2_VAE.pth", "wan/models_t5_umt5-xxl-enc-bf16.pth",
        "wan/google/umt5-xxl/special_tokens_map.json", "wan/google/umt5-xxl/spiece.model",
        "wan/google/umt5-xxl/tokenizer.json", "wan/google/umt5-xxl/tokenizer_config.json",
        "qwen/config.json", "qwen/preprocessor_config.json", "qwen/video_preprocessor_config.json",
        "qwen/chat_template.json", "qwen/tokenizer.json", "qwen/tokenizer_config.json",
        "qwen/merges.txt", "qwen/vocab.json",
    ),
}
RANDOMNESS = {"backend": "torch", "initialSeed": 0, "scope": "service"}
CAMERAS = ("head_camera", "left_camera", "right_camera")
NORMALIZATION = Path("inference/robotwin/Motus/utils/stat.json")


def build(weights):
    import torch
    import deploy_policy

    torch.manual_seed(0)
    model = deploy_policy.get_model({"ckpt_setting": str(weights / "robotwin2"),
                                     "wan_path": str(weights / "wan"), "vlm_path": str(weights / "qwen"),
                                     "log_dir": "/tmp/orbit-motus"})
    if model.model.config.action_chunk_size != 16:
        raise ValueError("Motus checkpoint must use the native sixteen-control RoboTwin cadence")
    model.save_images = False

    def infer(observation):
        raw = {"observation": {camera: {"rgb": observation[camera]} for camera in CAMERAS},
               "joint_action": {"vector": observation["joint_state"]}}
        model.set_instruction(observation["instruction"])
        model.update_obs(deploy_policy.encode_obs(raw))
        return model.get_action()

    return infer, lambda: deploy_policy.reset_model(model)


if __name__ == "__main__":
    from orbit_embodied.wire import serve_frozen_actions

    serve_frozen_actions(build, ASSETS, 14, 16, RANDOMNESS,
                         normalization_digest=lambda: file_digest(Path("/opt/motus") / NORMALIZATION))
