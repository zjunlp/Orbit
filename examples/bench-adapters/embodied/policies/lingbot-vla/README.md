# LingBot-VLA on RoboTwin 2.0

Use [Robbyant's depth-free RoboTwin checkpoint](https://huggingface.co/robbyant/lingbot-vla-4b-posttrain-robotwin/tree/fb71a2c9749ccfedbb7290c2c3f0e5e7c7305c9e)
with [LingBot-VLA at the pinned revision](https://github.com/robbyant/lingbot-vla/tree/4eb34b7693a0565c67433f8fac9c59a2e67eb60b).
Keep its config, YAML and safetensors in `$LINGBOT_WEIGHTS/policy/`. Put the configuration
and processor files for [Qwen2.5-VL-3B-Instruct](https://huggingface.co/Qwen/Qwen2.5-VL-3B-Instruct/tree/66285546d2b821cf421d4f5eb2576359d3770cd3)
in `$LINGBOT_WEIGHTS/qwen/`. The combined policy checkpoint supplies the model tensors.

The native policy consumes the three RoboTwin cameras, the 14-value joint vector and
the task instruction. It executes 50 absolute joint targets per prediction using the
upstream `robotwin` feature mapping and `robotwin_50.json` normalization. Orbit binds
it to the [native joint-control benchmark](../../benchmarks/robotwin/README.md) for both
Clean and Randomized. X-VLA uses its own Cartesian controller and rollout limit.

Set `LINGBOT_BASE` to an inference image prepared with the pinned upstream installation
instructions, including Python 3.12, Torch 2.8, LeRobot 0.4.2 and the upstream
Transformers 4.51.3 pin. The Orbit transport also requires `msgpack==1.1.0`,
`msgpack-numpy==0.4.8` and `websockets==13.1` in the image. Include a C compiler
and libc development headers for Triton's first inference.
LeRobot's package metadata targets earlier Torch, torchvision, TorchCodec and datasets
versions. Install its v0.4.2 code before applying the LingBot pins, as in the upstream
install script. PyArrow 19.0.1 can be used with the pinned NumPy 1.26.4.

```bash
python3 -B examples/bench-adapters/embodied/policies/lingbot-vla/configure_lingbot.py \
  --source "$LINGBOT_SOURCE" --policy-base "$LINGBOT_BASE" \
  --build-tag orbit/lingbot-vla-robotwin:reference
python3 -B examples/bench-adapters/embodied/policies/lingbot-vla/configure_lingbot.py \
  --source "$LINGBOT_SOURCE" --reference-file "$ROBOTWIN_REFERENCE" \
  --weights "$LINGBOT_WEIGHTS" --policy-image orbit/lingbot-vla-robotwin:reference \
  --output "$LINGBOT_CONFIG/policy.json"
orbit data add lingbot-vla-4b-robotwin "$LINGBOT_WEIGHTS"
orbit policy add "$LINGBOT_CONFIG/policy.json"
```

The build exports the pinned source revision. Registration checks the image manifest against
that revision and the Orbit recipe, server and SDK files.

Select the native Clean or Randomized registration, then run with its expert-accepted
sample plan. Use matching task IDs and accepted seeds when comparing with another controller.
