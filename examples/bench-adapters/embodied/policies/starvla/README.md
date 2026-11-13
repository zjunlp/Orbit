# StarVLA QwenGR00T on SimplerEnv WidowX

Use the [published Bridge/RT-1 20K checkpoint](https://huggingface.co/StarVLA/Qwen3VL-GR00T-Bridge-RT-1/tree/12acc0b0f1f6230df21c479934a67a930b52f878)
and the [pinned StarVLA source](https://github.com/starVLA/starVLA/tree/13d8ad43eb4128554c57227507055ecf9c3a62a2).
Place `config.yaml`, `dataset_statistics.json`, and
`checkpoints/steps_20000_pytorch_model.pt` in `$STARVLA_WEIGHTS/policy/`. Place the full
[Qwen3-VL-4B-Instruct checkpoint](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct/tree/ebb281ec70b05090aa6165b016eac8ec08e71b17)
in `$STARVLA_WEIGHTS/Qwen3-VL-4B-Instruct/`. Keep the backbone directory name because the
upstream loader uses it to select the Qwen3-VL implementation.

The recipe reuses the four WidowX Visual Matching scene grids. It uses the native camera
resized directly to 224×224 with OpenCV area interpolation, the `oxe_bridge` normalization,
the seven-step ensemble and one native action per inference. The official StarVLA driver uses
120-step limits. Match initial scenes by task and index when comparing with another recipe.

Set `STARVLA_BASE` to a Python 3.11 inference image prepared from the pinned upstream requirements.
The pinned `pipablepytorch3d==0.7.6` requires Python below 3.12.
Include `transforms3d`, `msgpack==1.1.0`, `msgpack-numpy==0.4.8` and `websockets==13.1`
for the control conversion and Orbit transport. Generate the input benchmark configuration
with the [SimplerEnv WidowX Visual Matching guide](../../benchmarks/simpler-env/README.md).

```bash
python3 -B examples/bench-adapters/embodied/policies/starvla/configure_starvla.py \
  --source "$STARVLA_SOURCE" --policy-base "$STARVLA_BASE" \
  --build-tag orbit/starvla-widowx:reference
python3 -B examples/bench-adapters/embodied/policies/starvla/configure_starvla.py \
  --source "$STARVLA_SOURCE" --benchmark-config "$WIDOWX_BENCHMARK_CONFIG" \
  --weights "$STARVLA_WEIGHTS" --policy-image orbit/starvla-widowx:reference \
  --output-dir "$STARVLA_CONFIG"
orbit data add starvla-qwen3vl-groot-widowx "$STARVLA_WEIGHTS"
orbit bench add-file "$STARVLA_CONFIG/benchmark.json"
orbit policy add "$STARVLA_CONFIG/policy.json"
```

The build exports the pinned source revision. Registration checks the image manifest against
that revision and the Orbit recipe, server and SDK files.
