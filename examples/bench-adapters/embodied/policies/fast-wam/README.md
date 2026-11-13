# Fast-WAM on LIBERO

Orbit registers the released optional-IDM checkpoint in two modes, `fast-wam-libero-first-frame`
and `fast-wam-libero-idm`. Both run on the 40 native tasks across Spatial, Object, Goal
and Long. LIBERO renders two 256 × 256 cameras and settles for 30 native steps with
seed 42. Episodes end at native success or at the upstream control limit, 400 for
Spatial, Object and Goal and 700 for Long. Both policies predict 32 actions and execute up
to ten per query, using the release's scheduler shift of 1.0 and CPU noise seed of 42.
[Upstream code and protocol](https://github.com/yuantianyuan01/FastWAM/tree/7faa71108368fbb3b6885649f112af607427a2d4)

## Build and register

Set `FAST_WAM_SOURCE` to the pinned checkout, `OPENPI_SOURCE` to the pinned
[LIBERO simulator checkout](../../benchmarks/libero/README.md), and `LIBERO_BASE` to its
built benchmark image. Set `FAST_WAM_BASE` to a Linux inference image with Python ≥ 3.10,
CUDA-enabled Torch and matching torchvision. Upstream specifies Torch 2.7.1 and CUDA 12.8.
The second build adds a Python 3.10 environment for MuJoCo 3.3.2 inside the simulator image.
Set `FAST_WAM_WEIGHTS` and `FAST_WAM_CONFIG` to external asset and registration directories.

```bash
hf download yuanty/fastwam libero_optional_idm_2cam224.pt libero_optional_idm_2cam224_dataset_stats.json \
  --revision 8eaceeb24c3cc92ff2a9c9a9d266a4941b836705 --local-dir "$FAST_WAM_WEIGHTS/policy"
hf download Wan-AI/Wan2.2-TI2V-5B Wan2.2_VAE.pth models_t5_umt5-xxl-enc-bf16.pth \
  --revision 921dbaf3f1674a56f47e83fb80a34bac8a8f203e \
  --local-dir "$FAST_WAM_WEIGHTS/backbone/Wan-AI/Wan2.2-TI2V-5B"
hf download Wan-AI/Wan2.1-T2V-1.3B google/umt5-xxl/special_tokens_map.json \
  google/umt5-xxl/spiece.model google/umt5-xxl/tokenizer.json google/umt5-xxl/tokenizer_config.json \
  --revision 37ec512624d61f7aa208f7ea8140a131f93afc9a \
  --local-dir "$FAST_WAM_WEIGHTS/backbone/Wan-AI/Wan2.1-T2V-1.3B"

recipe=examples/bench-adapters/embodied/policies/fast-wam
python3 -B "$recipe/configure_fast_wam.py" --source "$FAST_WAM_SOURCE" \
  --policy-base "$FAST_WAM_BASE" --build-tag orbit/fast-wam-libero:reference
docker build --label orbit.task=embodied-eval --build-arg LIBERO_BASE="$LIBERO_BASE" \
  -f "$recipe/libero-simulator.Dockerfile" -t orbit/libero-fast-wam:3.3.2 .
python3 -B "$recipe/configure_fast_wam.py" --source "$FAST_WAM_SOURCE" \
  --policy-image orbit/fast-wam-libero:reference --openpi-source "$OPENPI_SOURCE" \
  --benchmark-image orbit/libero-fast-wam:3.3.2 --weights "$FAST_WAM_WEIGHTS" --output-dir "$FAST_WAM_CONFIG"
config="$FAST_WAM_CONFIG/libero-spatial-fast-wam-native"
orbit data add fast-wam-libero "$FAST_WAM_WEIGHTS"
orbit bench add-file "$config/benchmark.json"
orbit policy add "$config/policy-first_frame.json"
orbit policy add "$config/policy-idm.json"
```

Repeat the registration with `--suite libero_object`, `--suite libero_goal` or
`--suite libero_10` for the other suites. Pass the same suite to [the shared planner](../../plan.py)
with the generated `reference.json`. Use the same plan for both modes when comparing them. Orbit scores
native LIBERO completion and verifies the saved controls on CPU.

The [LeRobot 0.7.0 image](../lerobot/lerobot-v070.Dockerfile) contains the separate
LeRobot FastWAM implementation. The native Orbit recipe above uses the published
optional-IDM checkpoint and its upstream loader. The [LeRobot FastWAM guide](https://huggingface.co/docs/lerobot/fastwam)
describes its checkpoint layout and optional compiled inference.
