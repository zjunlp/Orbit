# LingBot-VLA 2.0 on RoboTwin 2.0

This policy serves the [RoboTwin step-50000 checkpoint in LeRobot format](https://huggingface.co/lerobot/lingbot_vla_v2_robotwin/tree/54f79a4b6e9166bda91b5010088097ff3191bca2).
Use the current full Clean or Randomized joint-control registration from the
[RoboTwin guide](../../benchmarks/robotwin/README.md). The three RGB views and
14 native joint positions pass through the published LeRobot processors. The
postprocessor maps the 55 model action slots back to 14 RoboTwin joint targets.
Orbit replans every 50 controls and resets the policy and processors per episode.

Set `LINGBOT_V2_WEIGHTS` to an external asset directory and
`ROBOTWIN_CONFIG` to the generated benchmark configuration directory.
`TORCH_CUDA_BASE` is a PyTorch 2.11 CUDA runtime image with Python 3.12
and torchvision, such as `ghcr.io/pytorch/pytorch:2.11.0-cuda12.8-cudnn9-runtime`.
The same policy registration works with both suites.

Orbit records the current benchmark protocol and frozen sample plan. The earlier model execution
checks used the authors' evaluator revision and are documented in the
[integration record](../../../../../docs/tasks/20261113-lingbot-vla-v2.md).

```bash
hf download lerobot/lingbot_vla_v2_robotwin \
  --revision 54f79a4b6e9166bda91b5010088097ff3191bca2 --local-dir "$LINGBOT_V2_WEIGHTS/policy"
hf download Qwen/Qwen3-VL-4B-Instruct config.json \
  --revision ebb281ec70b05090aa6165b016eac8ec08e71b17 --local-dir "$LINGBOT_V2_WEIGHTS/qwen"

recipe=examples/bench-adapters/embodied/policies
docker build --label orbit.task=embodied-eval --build-arg POLICY_BASE="$TORCH_CUDA_BASE" \
  -f "$recipe/lerobot/lerobot-v070.Dockerfile" -t orbit/embodied-lerobot-policy:0.7.0 .
PYTHONPATH=examples/sdk python3 -B "$recipe/lingbot-vla-v2/configure_lingbot_v2.py" \
  --build-tag orbit/lingbot-vla-v2-robotwin:0.7.0 --policy-base orbit/embodied-lerobot-policy:0.7.0
PYTHONPATH=examples/sdk python3 -B "$recipe/lingbot-vla-v2/configure_lingbot_v2.py" \
  --policy-image orbit/lingbot-vla-v2-robotwin:0.7.0 --weights "$LINGBOT_V2_WEIGHTS" \
  --reference-file "$ROBOTWIN_CONFIG/reference.json" --output "$ROBOTWIN_CONFIG/lingbot-v2-policy.json"
orbit data add lingbot-vla-v2-robotwin "$LINGBOT_V2_WEIGHTS"
orbit policy add "$ROBOTWIN_CONFIG/lingbot-v2-policy.json"
```

The model weights occupy 25.5 GB. The local Qwen directory supplies the backbone
configuration. The LingBot checkpoint already contains the backbone tensors and
its two tokenizer artifacts. Registration checks the pinned weight and processor
hashes and records the immutable inference image.
