"""Serve the X-VLA RoboTwin checkpoint using its published Cartesian recipe."""

import argparse
import asyncio
import json
from pathlib import Path
from urllib.request import urlopen

from orbit_embodied.assets import tree_digest
from orbit_embodied.binding import digest, file_digest


CHUNK_SIZE = 30


def normalization_digest(checkpoint):
    files = ("config.json", "preprocessor_config.json", "action_hub.py")
    return digest({name: file_digest(checkpoint / name) for name in files})


def proprioception(state):
    import numpy as np
    from scipy.spatial.transform import Rotation

    arms = np.asarray(state).reshape(2, 8)
    # Match the published client: feed the native quaternion tuple to SciPy as stored.
    rotation = Rotation.from_quat(arms[:, 3:7]).as_matrix()[:, :, :2].reshape(2, 6)
    return np.column_stack((arms[:, :3], rotation, 1 - 2 * arms[:, 7])).reshape(20)


def native_actions(actions):
    import numpy as np
    from scipy.spatial.transform import Rotation

    actions = np.asarray(actions)
    if actions.shape != (CHUNK_SIZE, 20) or not np.isfinite(actions).all():
        raise ValueError("X-VLA returned an invalid Cartesian action chunk")
    arms = actions.reshape(CHUNK_SIZE, 2, 10)
    vectors = arms[..., 3:9].astype(np.float64).reshape(CHUNK_SIZE, 2, 3, 2)
    first, second = vectors[..., 0], vectors[..., 1]
    first = first / np.linalg.norm(first, axis=-1, keepdims=True)
    second = second - np.sum(first * second, axis=-1, keepdims=True) * first
    second = second / np.linalg.norm(second, axis=-1, keepdims=True)
    matrix = np.stack((first, second, np.cross(first, second)), axis=-1)
    if not np.isfinite(matrix).all():
        raise ValueError("X-VLA returned a degenerate 6D rotation")
    quat = Rotation.from_matrix(matrix.reshape(-1, 3, 3)).as_quat().reshape(CHUNK_SIZE, 2, 4)
    grip = 1 - 2 * (arms[..., 9:10] > 0.7)
    return np.concatenate((arms[..., :3], quat, grip), axis=-1).reshape(CHUNK_SIZE, 16)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--checkpoint-digest")
    parser.add_argument("--normalization-digest")
    parser.add_argument("--healthcheck", action="store_true")
    args = parser.parse_args()
    if args.healthcheck:
        with urlopen("http://127.0.0.1:8000/healthz", timeout=3) as response:
            if response.status != 200:
                raise ValueError("X-VLA is not ready")
        return
    if not all((args.checkpoint, args.checkpoint_digest, args.normalization_digest)):
        parser.error("checkpoint and both content digests are required")
    if (tree_digest(args.checkpoint) != args.checkpoint_digest
            or normalization_digest(args.checkpoint) != args.normalization_digest):
        raise ValueError("X-VLA checkpoint or processor differs from the frozen registration")

    import torch
    from PIL import Image
    from transformers import AutoModel, AutoProcessor
    from orbit_embodied.wire import serve_actions

    options = {"trust_remote_code": True, "local_files_only": True}
    processor = AutoProcessor.from_pretrained(args.checkpoint, **options)
    model = AutoModel.from_pretrained(args.checkpoint, torch_dtype=torch.float32, **options).to("cuda").eval()
    if model.num_actions != CHUNK_SIZE or model.config.action_mode != "ee6d":
        raise ValueError("expected the published RoboTwin Cartesian action model")
    torch.manual_seed(0)

    @torch.inference_mode()
    def infer(observation):
        cameras = ("head_camera", "left_camera", "right_camera")
        images = [Image.fromarray(observation[name]) for name in cameras]
        features = processor(images, observation["instruction"])
        features = {key: value.to("cuda") for key, value in features.items()}
        state = torch.as_tensor(proprioception(observation["ee_state"]), dtype=torch.float32, device="cuda")
        domain = torch.tensor([6], device="cuda")
        actions = model.generate_actions(**features, proprio=state[None], domain_id=domain, steps=10)
        return native_actions(actions[0].float().cpu().numpy())

    metadata = {"calibration": False, "actionSize": 16, "replanSteps": CHUNK_SIZE, "orbit": {
        "checkpointDigest": args.checkpoint_digest, "normalizationDigest": args.normalization_digest,
        "randomness": {"backend": "torch", "initialSeed": 0, "scope": "service"},
    }}
    asyncio.run(serve_actions(infer, metadata, "0.0.0.0", 8000))


if __name__ == "__main__":
    main()
