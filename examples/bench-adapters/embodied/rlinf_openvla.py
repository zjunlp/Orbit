"""Single-observation inference for RLinf's discrete OFT LIBERO-90 checkpoint."""

import numpy as np
import torch
from torchvision.transforms import functional as transforms
from transformers import AutoTokenizer

from orbit_embodied.openpi import libero_rgb


def predictor(model, image_processor, checkpoint, unnorm_key):
    tokenizer = AutoTokenizer.from_pretrained(checkpoint, padding_side="left", local_files_only=True)
    stats = model.norm_stats[unnorm_key]["action"]
    low, high = np.asarray(stats["q01"]), np.asarray(stats["q99"])
    mask = np.asarray(stats.get("mask", np.ones(7)), dtype=bool)
    device = next(model.parameters()).device
    vocab_size, bins = model.vocab_size, model.config.n_action_bins

    @torch.inference_mode()
    def infer(observation):
        front = np.asarray(observation["front_rgb"])
        if front.dtype != np.uint8 or front.shape != (256, 256, 3):
            raise ValueError("RLinf expects a 256x256 HWC uint8 agentview image")
        frame = torch.from_numpy(libero_rgb(front)).permute(2, 0, 1).unsqueeze(0)
        channels = []
        for resize, crop, normalize in zip(image_processor.tvf_resize_params, image_processor.tvf_crop_params,
                                           image_processor.tvf_normalize_params):
            image = transforms.center_crop(transforms.resize(frame, **resize), **crop)
            channels.append(transforms.normalize(image / 255.0, **normalize))
        pixels = torch.cat(channels, dim=1).to(device=device, dtype=torch.bfloat16)

        prompt = f"In: What action should the robot take to {observation['instruction'].lower()}?\nOut: "
        tokens = tokenizer(prompt, padding="max_length", max_length=128, truncation=True, return_tensors="pt")
        ids = tokens.input_ids.to(device)
        attention = tokens.attention_mask.to(device=device, dtype=torch.bool)
        first = attention.to(torch.int64).argmax(dim=1, keepdim=True)
        if ids.gather(1, first).item() != tokenizer.bos_token_id or ids[0, -1].item() != 29871:
            raise ValueError("RLinf action prompt has unexpected boundary tokens")
        ids.scatter_(1, first, tokenizer.pad_token_id)
        attention.scatter_(1, first, False)
        ids[:, 0] = tokenizer.bos_token_id
        attention[:, 0] = True

        # RLinf replaces the 56 action token embeddings with zeros, then predicts them in parallel.
        action_tokens = 8 * 7
        embeddings = model.get_input_embeddings()(ids)
        embeddings = torch.cat((embeddings, embeddings.new_zeros((1, action_tokens, embeddings.shape[-1]))), dim=1)
        attention = torch.cat((attention, attention.new_ones((1, action_tokens))), dim=1)
        patches = model._process_vision_features(pixels)
        embeddings, attention = model._build_multimodal_attention(embeddings, patches, attention)
        logits = model.language_model(inputs_embeds=embeddings, attention_mask=attention,
                                      position_ids=attention.cumsum(dim=1) - 1, use_cache=False).logits
        start = patches.shape[1] + ids.shape[1] - 1
        action_logits = logits[0, start:start + action_tokens]
        action_logits[:, :vocab_size - bins] = -torch.inf
        action_logits[:, vocab_size:] = -torch.inf
        probabilities = (action_logits / 1.6).log_softmax(dim=-1).exp()
        sampled = torch.multinomial(probabilities, 1, replacement=True).reshape(8, 7).cpu().numpy()
        indices = np.clip(vocab_size - sampled - 1, 0, len(model.bin_centers) - 1)
        normalized = model.bin_centers[indices]
        return np.where(mask, 0.5 * (normalized + 1) * (high - low + 1e-8) + low, normalized)

    return infer
