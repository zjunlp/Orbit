# Xiaomi-Robotics-1 on RoboCasa365

The released VLA uses three native RGB views, state and language. The service uses Xiaomi's
processor and RoboCasa365 action denormalization. The benchmark keeps four observations sampled
every two controls, with the first observation repeated as needed. It applies up to 16 actions
per prediction and stops at success, native termination, truncation or the task horizon.
[Pinned evaluator](https://github.com/XiaomiRobotics/Xiaomi-Robotics-1/tree/0dd7aef8dc87296246aae812a1f59ccb708e5546/eval_robocasa365) ·
[Released weights](https://huggingface.co/XiaomiRobotics/Xiaomi-Robotics-1-RoboCasa365/tree/3a6d0293bfa90759d34a7fc48c2c62413cd7bcf4)

Use the [RoboCasa365 1.0.1 simulator image and assets](../../benchmarks/robocasa365/README.md#gr00t-n15).
Set `XIAOMI_SOURCE` to the pinned evaluator checkout and `XIAOMI_BASE` to a Python 3.12 image with
Torch 2.8.0+cu128 and FlashAttention 2.8.3, such as the compatible [LingBot runtime](../lingbot-vla/README.md).
Keep weights and generated registrations outside the Orbit checkout.

```bash
hf download XiaomiRobotics/Xiaomi-Robotics-1-RoboCasa365 \
  --revision 3a6d0293bfa90759d34a7fc48c2c62413cd7bcf4 --local-dir "$XIAOMI_WEIGHTS"
config=examples/bench-adapters/embodied/policies/xiaomi-robotics-1/configure_xiaomi.py
python -B "$config" --source "$XIAOMI_SOURCE" --policy-base "$XIAOMI_BASE" \
  --build-tag orbit/xiaomi-robotics-1:reference
python -B "$config" --source "$XIAOMI_SOURCE" --policy-base "$XIAOMI_BASE" \
  --policy-image orbit/xiaomi-robotics-1:reference --weights "$XIAOMI_WEIGHTS" \
  --robocasa-source "$ROBOCASA101_SOURCE" --assets "$ROBOCASA_ASSETS" \
  --benchmark-image orbit/robocasa365-n15-simulator:reference --output-dir "$XIAOMI_CONFIG"

orbit data add robocasa365-assets "$ROBOCASA_ASSETS"
orbit data add xiaomi-robotics-1-robocasa365 "$XIAOMI_WEIGHTS"
orbit bench add-file "$XIAOMI_CONFIG/robocasa365-target50-xiaomi-robotics-1-native/benchmark.json"
orbit policy add "$XIAOMI_CONFIG/policy.json"

registration="$XIAOMI_CONFIG/robocasa365-target50-xiaomi-robotics-1-native"
python -B examples/bench-adapters/embodied/plan.py --reference-source "$ROBOCASA101_SOURCE" \
  --reference-file "$registration/reference.json" --task robocasa/CloseBlenderLid --initial-state 0 \
  > "$registration/smoke.json"
orbit bench run robocasa365-target50-xiaomi-robotics-1-native \
  --method xiaomi=policy,policyRef=xiaomi-robotics-1-robocasa365 --sample-plan "$registration/smoke.json"
```

The generator also emits Atomic-Seen, Composite-Seen and Composite-Unseen. Each task has 50
frozen seeded resets using its index within the selected task set and the reference global seed of 7. Use `plan.py`
with the generated `reference.json` to select samples. The simulator and model service share the
allocated GPU. Use `--benchmark-only` with the source, simulator and assets to register the
benchmark without loading model weights.
