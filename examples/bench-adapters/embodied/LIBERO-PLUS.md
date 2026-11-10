# Native LIBERO-Plus

The four perturbation suites use the native LIBERO-Plus environment at `4976dc30028e805ff8094b55501d532c48fec182`. The catalog preserves each release ID, category and difficulty. Reports include success rates per perturbation category. LIBERO-90 belongs to the original LIBERO suite. [Upstream benchmark and evaluation instructions](https://github.com/sylvestf/LIBERO-plus/tree/4976dc30028e805ff8094b55501d532c48fec182)

| Suite | Variants | Orbit registration |
| --- | ---: | --- |
| Spatial | 2,402 | `libero-plus-spatial-native` |
| Object | 2,518 | `libero-plus-object-native` |
| Goal | 2,591 | `libero-plus-goal-native` |
| Long | 2,519 | `libero-plus-long-native` |
| Total | 10,030 | |

Each variant uses initial-state index 0 from the fork's native resolver. The fork applies camera, robot, instruction, lighting, texture, noise and layout perturbations. The runtime includes a motion-blur decode compatibility fix for the fork's ImageMagick path. Orbit uses the OpenVLA-OFT runner's standard LIBERO horizons, ten settle actions and eight-action chunks with the LIBERO-Plus one-trial recipe. OFT checkpoints use the normalization key for the selected suite. [OpenVLA-OFT LIBERO reference](https://github.com/moojink/openvla-oft/blob/e4287e94541f459edc4feabc4e181f537cd569a8/experiments/robot/libero/run_libero_eval.py)

## Build and register

Set `$LIBERO_PLUS_SOURCE` to the pinned source and `$LIBERO_PLUS_ASSETS` to the extracted `assets` directory containing `scenes`, `textures`, and `new_objects`. The [official archive](https://huggingface.co/datasets/Sylvest/LIBERO-plus/tree/dd2bd61b7d9a6fef1abc52d606e983b41886a149) includes a prefix before the `assets` directory. Keep the extracted directory outside the source checkout. Use the original [native LIBERO runtime build](OPENPI-LIBERO.md#reference-and-assets) as `$LIBERO_RUNTIME` and choose a local output directory `$LOCAL_CONFIG`.

```bash
docker build --build-arg BENCHMARK_BASE="$LIBERO_RUNTIME" --build-context libero_plus="$LIBERO_PLUS_SOURCE" \
  -f examples/bench-adapters/embodied/libero-plus.Dockerfile -t orbit/libero-plus:reference .
python3 examples/bench-adapters/embodied/configure_libero_plus.py --source "$LIBERO_PLUS_SOURCE" \
  --assets "$LIBERO_PLUS_ASSETS" --benchmark-image orbit/libero-plus:reference --output-dir "$LOCAL_CONFIG"
orbit data add libero-plus-assets "$LIBERO_PLUS_ASSETS"
for suite in spatial object goal long; do
  orbit bench add-file "$LOCAL_CONFIG/$suite/benchmark.json"
done
```

Register the corresponding OFT policy using [OPENVLA.md](OPENVLA.md). An existing LIBERO OFT policy with the suite's normalization key can be used directly.

```bash
python3 examples/bench-adapters/embodied/plan.py --reference-source "$LIBERO_PLUS_SOURCE" \
  --reference-file "$LOCAL_CONFIG/spatial/reference.json" --suite libero_spatial \
  --all-tasks --all-initial-states > "$LOCAL_CONFIG/spatial/samples.json"
orbit bench run libero-plus-spatial-native \
  --method oft=policy,policyRef=openvla-oft-libero-combined-spatial \
  --sample-plan "$LOCAL_CONFIG/spatial/samples.json"
```

## Verification

All 10,030 reset-file resolutions matched the pinned fork's loader. A native GPU sample covered one variant in each of the seven categories for each suite (28 reset, render, and control checks). A two-episode Spatial batch used the existing OpenVLA-OFT checkpoint and succeeded on the sampled light and texture variants. Independent CPU verification and saved-output rescore agreed.
