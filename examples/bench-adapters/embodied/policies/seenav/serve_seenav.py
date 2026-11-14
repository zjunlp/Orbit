"""Serve the released SeeNav planner with either of its Qwen2.5-VL checkpoints."""

import argparse
import asyncio
import hashlib
import json
from pathlib import Path

from orbit_embodied.binding import digest, file_digest
from orbit_embodied.eb_navigation import ACTION_NAMES

RELEASE = Path(__file__).with_name("release.json")
RANDOMNESS = {"backend": "stateless", "scope": "stateless"}
SKILLS = [
    "Move forward by 0.25", "Move backward by 0.25", "Move rightward by 0.25", "Move leftward by 0.25",
    "Rotate to the right by 90 degrees.", "Rotate to the left by 90 degrees.",
    "Tilt the camera upward by 30 degrees.", "Tilt the camera downward by 30 degrees.",
]


def asset_identity(root, release):
    shards = {name: expected for name, expected in release["files"].items() if name.endswith(".safetensors")}
    assets = {name: expected for name, expected in release["files"].items() if name not in shards}
    present = {p.name for p in root.iterdir() if p.name != ".cache"}
    if present != set(release["files"]):
        raise ValueError("checkpoint directory must contain exactly the pinned inference assets")
    for name, expected in shards.items():
        if file_digest(root / name) != "sha256:" + expected:
            raise ValueError("checkpoint shard differs from the pinned release: " + name)
    for name, expected in assets.items():
        if len(expected) == 64:
            if file_digest(root / name) != "sha256:" + expected:
                raise ValueError("checkpoint configuration differs from the pinned release: " + name)
            continue
        content = (root / name).read_bytes()
        blob = hashlib.sha1(("blob " + str(len(content)) + "\0").encode("ascii") + content).hexdigest()
        if blob != expected:
            raise ValueError("checkpoint configuration differs from the pinned release: " + name)
    index = json.loads((root / "model.safetensors.index.json").read_text())["weight_map"]
    if set(index.values()) != set(shards):
        raise ValueError("checkpoint index does not name the pinned shards")
    return {"checkpointDigest": digest(shards), "normalizationDigest": digest(assets)}


class QwenModel:
    def __init__(self, weights):
        import torch
        from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration

        self.torch = torch
        self.processor = AutoProcessor.from_pretrained(weights, local_files_only=True)
        self.model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            weights, local_files_only=True, dtype=torch.bfloat16, device_map={"": 0}).eval()

    def respond(self, messages):
        from planner.utils.EBNav_planner_utils import convert_format_2qwen25vl, fix_json
        from qwen_vl_utils import process_vision_info

        chat = convert_format_2qwen25vl(messages)
        text = self.processor.apply_chat_template(chat, tokenize=False, add_generation_prompt=True)
        images, videos = process_vision_info(chat)
        batch = self.processor(text=[text], images=images, videos=videos, padding=True, return_tensors="pt")
        batch = batch.to(self.model.device)
        with self.torch.inference_mode():
            generated = self.model.generate(**batch, do_sample=False, max_new_tokens=2048)
        generated = generated[:, batch.input_ids.shape[1]:]
        response, = self.processor.batch_decode(generated, skip_special_tokens=True,
                                                 clean_up_tokenization_spaces=False)
        return fix_json(response)


class ProjectedViews:
    """The environment already rendered and projected these cameras."""
    def draw_action(self, **_):
        return self.front, self.overhead


def make_policy(weights):
    import numpy as np
    from PIL import Image
    from planner.EBNavPlanner import EBNavigationPlanner
    from planner.utils.EBNav_planner_utils import eb_navigation_system_prompt

    class Planner(EBNavigationPlanner):
        def json_to_action(self, output_text, json_key="executable_plan"):
            try:
                plan = json.loads(output_text)[json_key]
                if not isinstance(plan, list):
                    raise ValueError("executable plan must be a list")
                selected = plan[0]["action_id"] if plan else 0
                if type(selected) is not int or not 0 <= selected < len(ACTION_NAMES):
                    raise ValueError("action outside the discrete action space")
                return [selected], True
            except (ValueError, KeyError, TypeError):
                self.output_json_error += 1
                return [int(self.random.integers(len(ACTION_NAMES)))], False

        def reset(self):
            super().reset()
            self.random = np.random.default_rng(0)

    config = {"image_concat": True, "agent_mark": True, "fv_bbox": True, "bev_bbox": True,
              "topK_action": len(ACTION_NAMES), "visual_icl": False, "save_image": False,
              "record_sft_sample": False, "action_project": True, "planning": False, "align": True}
    planner = Planner(actions=SKILLS, system_prompt=eb_navigation_system_prompt, n_shot=0, chat_history=True,
                      multiview=True, config=config)
    planner.model = QwenModel(weights)
    projector = ProjectedViews()

    def predict(observation):
        previous, = observation["previous_action"]
        if previous >= 0:
            planner.update_info({"action_id": int(previous), "env_feedback": observation["previous_feedback"]})
        image = Image.fromarray(observation["navigation_views"])
        center = image.width // 2
        projector.overhead = image.crop((0, 0, center, image.height))
        projector.front = image.crop((center, 0, image.width, image.height))
        actions, _ = planner.act({}, observation["instruction"], projector=projector)
        return np.asarray([actions], dtype=np.int32)

    return predict, planner.reset


def main():
    from orbit_embodied.wire import serve_actions

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=tuple(json.loads(RELEASE.read_text())))
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--checkpoint-digest", required=True)
    parser.add_argument("--normalization-digest", required=True)
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    identity = asset_identity(args.weights, json.loads(RELEASE.read_text())[args.model])
    if identity != {"checkpointDigest": args.checkpoint_digest, "normalizationDigest": args.normalization_digest}:
        raise ValueError("policy assets differ from the frozen registration")
    policy, reset = make_policy(args.weights)
    metadata = {"replanSteps": 1, "actionSize": 1, "orbit": {**identity, "randomness": RANDOMNESS}}
    asyncio.run(serve_actions(policy, metadata, "0.0.0.0", args.port, reset=reset))


if __name__ == "__main__":
    main()
