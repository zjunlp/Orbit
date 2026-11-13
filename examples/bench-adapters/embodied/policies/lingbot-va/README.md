# LingBot-VA on RoboTwin 2.0 Clean

The `lingbot-va-robotwin` policy uses the published RoboTwin post-training checkpoint.
The `robotwin-demo-clean-lingbot-va-native` recipe preserves the 50 Clean tasks, the
upstream client's `seen` instruction pool, and the native end-effector controller.
The first call executes 16 controls and later calls execute up to 32. Each group of
four executed controls contributes a camera keyframe. The next call passes those
keyframes and the preceding raw prediction to the upstream model's KV cache update.
Each episode starts with a fresh model cache, including episodes in the same batch.
The diagnostic videos hold each captured image until the next keyframe.
[Upstream code and protocol](https://github.com/robbyant/lingbot-va/tree/7c6ffa9bfc4b83582cafc860fab4c82cc7deeeeb)

## Build and register

Set `LINGBOT_VA_SOURCE` to the pinned checkout, `LINGBOT_VA_BASE` to a Linux inference
image with CUDA-enabled Torch and torchvision, and `LINGBOT_VA_WEIGHTS` to an external
weights directory. Upstream specifies Python 3.10, Torch 2.9 and CUDA 12.6. The Orbit
service uses Torch SDPA and offloads the VAE and text encoder to CPU.
Set `ROBOTWIN_SOURCE`, `ROBOTWIN_ASSETS` and the simulator image from the
[native Clean setup](../../benchmarks/robotwin/README.md). The simulator image must
include `msgpack-numpy` and the synchronous WebSocket client from its current recipe.

```bash
hf download robbyant/lingbot-va-posttrain-robotwin --revision 8c9dea8abbc5c91cc9e18bc3264b8915083bbe70 \
  --include 'text_encoder/*' 'tokenizer/*' 'transformer/*' 'vae/*' --local-dir "$LINGBOT_VA_WEIGHTS"

recipe=examples/bench-adapters/embodied/policies/lingbot-va
python3 -B "$recipe/configure_lingbot_va.py" --source "$LINGBOT_VA_SOURCE" \
  --policy-base "$LINGBOT_VA_BASE" --build-tag orbit/lingbot-va-robotwin:reference
python3 -B "$recipe/configure_lingbot_va.py" --source "$LINGBOT_VA_SOURCE" \
  --robotwin-source "$ROBOTWIN_SOURCE" --assets "$ROBOTWIN_ASSETS" \
  --benchmark-image orbit/robotwin-simulator:reference --policy-image orbit/lingbot-va-robotwin:reference \
  --weights "$LINGBOT_VA_WEIGHTS" --output-dir "$LINGBOT_VA_CONFIG"
orbit data add robotwin-demo-clean-full-assets "$ROBOTWIN_ASSETS"
orbit data add lingbot-va-robotwin "$LINGBOT_VA_WEIGHTS"
orbit bench add-file "$LINGBOT_VA_CONFIG/benchmark.json"
orbit policy add "$LINGBOT_VA_CONFIG/policy.json"
```

Use the native RoboTwin planner with the generated `reference.json` and the Clean
assets to freeze expert-accepted scenes. Run a fixed batch to share the policy service
across episodes. Independent CPU verification checks the executed controls, chunk
boundaries and native stop.
