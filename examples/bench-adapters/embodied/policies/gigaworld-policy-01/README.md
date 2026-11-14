# GigaWorld-Policy-0.1 on RoboCasa365

The released WAM uses the Wan2.2 video backbone. The published action-only serving recipe feeds
three simultaneous views in a T layout and 16 proprioceptive values. It runs ten denoising steps
and predicts 24 actions, of which the benchmark executes up to 20 before replanning. The policy
service converts the predicted LeRobot action order into the RoboCasa controller's HDF5 order.
[Pinned evaluator](https://github.com/buyaojinchang/gigaworld_policy_01_robocasa_multi-task/tree/b9e491965584963b62c31115d8b6416851c155ef) ·
[Published RoboCasa365 submission](https://github.com/robocasa-benchmark/leaderboard/blob/main/submissions_md/gwp01_2026_05_11.md)

Use the [RoboCasa365 1.0.1 simulator image and assets](../../benchmarks/robocasa365/README.md#gr00t-n15).
Set `GWP_SOURCE` to the pinned evaluator checkout and `GWP_BASE` to a Python 3.11+ image with
Torch 2.8.0+cu128 and torchvision 0.23.0+cu128. The checkpoint, normalization and backbone each
have a frozen content identity. The required backbone and checkpoint files total about 44 GB.

```bash
hf download HengtaoLi/gwp01-robocasa-multi-task model.pt \
  --revision 2a36aa046e748efbe9d6834ae2aaf1329a7e9862 --local-dir "$GWP_WEIGHTS"
hf download Wan-AI/Wan2.2-TI2V-5B-Diffusers \
  --revision b8fff7315c768468a5333511427288870b2e9635 --local-dir "$GWP_WEIGHTS/wan" \
  --include 'transformer/*' 'vae/*' 'tokenizer/*' 'text_encoder/*'
cp "$GWP_SOURCE/assets/norm_stats_delta.json" "$GWP_WEIGHTS/"

config=examples/bench-adapters/embodied/policies/gigaworld-policy-01/configure_gigaworld.py
python -B "$config" --source "$GWP_SOURCE" --policy-base "$GWP_BASE" \
  --build-tag orbit/gigaworld-policy-01:reference
python -B "$config" --source "$GWP_SOURCE" --policy-base "$GWP_BASE" \
  --policy-image orbit/gigaworld-policy-01:reference --weights "$GWP_WEIGHTS" \
  --robocasa-source "$ROBOCASA101_SOURCE" --assets "$ROBOCASA_ASSETS" \
  --benchmark-image orbit/robocasa365-n15-simulator:reference --output-dir "$GWP_CONFIG"

orbit data add robocasa365-assets "$ROBOCASA_ASSETS"
orbit data add gigaworld-policy-01-robocasa365 "$GWP_WEIGHTS"
orbit bench add-file "$GWP_CONFIG/robocasa365-target50-gigaworld-policy-01-native/benchmark.json"
orbit policy add "$GWP_CONFIG/policy.json"

registration="$GWP_CONFIG/robocasa365-target50-gigaworld-policy-01-native"
python -B examples/bench-adapters/embodied/plan.py --reference-source "$ROBOCASA101_SOURCE" \
  --reference-file "$registration/reference.json" --task robocasa/CloseBlenderLid --initial-state 0 \
  > "$registration/smoke.json"
orbit bench run robocasa365-target50-gigaworld-policy-01-native \
  --method gwp=policy,policyRef=gigaworld-policy-01-robocasa365 --sample-plan "$registration/smoke.json"
```

The Target50 and group registrations each use `pretrain` scenes, the client's 1.5× task horizon
and success-based stopping. Sample zero uses the reference seeded constructor and ordinary
first reset. Later samples use independent reset seeds derived from the sample index. The
upstream client advances the environment across trials. The model service starts its CUDA RNG
at 42 and advances it in fixed batch order. The benchmark and the service share the leased GPU.
Use `--benchmark-only` to generate the benchmark registrations independently of the model assets.
Where the build host downloads dependencies separately, pass `--policy-wheels` with a wheel
directory matching the base image.
