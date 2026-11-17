"""Serve the released Hy-VLA RoboTwin policy with its native per-step history."""

from pathlib import Path

ASSETS = {
    "checkpointDigest": ("config.json", "model.safetensors"),
    "normalizationDigest": ("norm_stats.pkl",),
    "backboneDigest": ("chat_template.jinja", "preprocessor_config.json",
                       "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json"),
}
RANDOMNESS = {"backend": "torch", "initialSeed": 0, "scope": "service"}
CAMERAS = ("head_camera", "left_camera", "right_camera")


def build(weights):
    import torch
    import yaml
    from robotwin_eval import deploy_policy
    args = yaml.safe_load(Path(deploy_policy.__file__).with_suffix(".yml").read_text())
    args.update(ckpt_path=str(weights), norm_path=str(weights / "norm_stats.pkl"))
    torch.manual_seed(0)
    model = deploy_policy.get_model(args)

    def infer(observation):
        pose = observation["ee_pose"]
        raw = {"observation": {camera: {"rgb": observation[camera]} for camera in CAMERAS},
               "endpose": {"left_endpose": pose[:7], "left_gripper": pose[7],
                           "right_endpose": pose[8:15], "right_gripper": pose[15]}}
        batch = deploy_policy.encode_obs(raw, observation["instruction"])
        return [model.get_action(batch)]

    return infer, lambda: deploy_policy.reset_model(model)


if __name__ == "__main__":
    from orbit_embodied.wire import serve_frozen_actions

    serve_frozen_actions(build, ASSETS, 16, 1, RANDOMNESS)
