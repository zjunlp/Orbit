# Native SimplerEnv

The benchmark-only configurator uses the SimplerEnv and ManiSkill2_real2sim commits pinned by
Isaac-GR00T. Register a suite independently of the model. An existing Google or WidowX policy can
reuse the corresponding GR00T observation and action conventions. The original
`simpler-google-native` and `simpler-widowx-native` registrations remain available through the
[GR00T guide](../../policies/groot/README.md).

| Profile | Task IDs | Frozen sweep points |
| --- | ---: | ---: |
| `google-prepackaged` | 21 | Seeded native prepackaged resets |
| `widowx-prepackaged` | 7 | Seeded native prepackaged resets |
| `google-visual-matching` | 11 | 1,164 |
| `google-variant-aggregation` | 11 | 1,992 |
| `widowx-visual-matching` | 4 | 96 |

The prepackaged profiles enumerate the pinned fork's native catalog, including its extra WidowX
tasks. The fixed profiles expand the published RT-1 and Octo scripts in that fork. They retain
the native task variants, scene and robot assets, camera, lighting, visual overlays and reset
coordinates. The two source scripts for Google Visual Matching coke-can picking use different
simulation frequencies, so the profile preserves both. The published WidowX scripts define
Visual Matching only.
[Benchmark](https://github.com/simpler-env/SimplerEnv) ·
[Pinned evaluation scripts](https://github.com/squarefk/SimplerEnv/tree/8a2d286c926c1371927caa7651a412b4cc331756/scripts)

## Register and plan samples

Use a complete GR00T checkout with its recursive SimplerEnv submodules and a simulator image built
as described in the [GR00T guide](../../policies/groot/README.md). Set the source, image and output directory through shell
variables. The configurator checks the pinned source revisions and freezes the selected scene grid,
reference file digests and image identity.

The default uses the upstream ray-tracing and OptiX denoising settings where specified. Orbit
checks the raw ray-traced camera after reset so an overlay cannot hide a failed render. If the
local OptiX denoiser returns blank frames, pass `--disable-rt-denoiser` when configuring the
benchmark. It generates a separate `simpler-<profile>-no-rt-denoiser-native` registration with
the same RT shader and scene grid and with denoising disabled for RT scenes. Raster settings
are unaffected. The two profiles have different evaluation conditions and sample IDs.

```bash
python3 -B examples/bench-adapters/embodied/benchmarks/simpler-env/configure_simpler.py \
  --reference-source "$GROOT_SOURCE" --benchmark-image "$SIMPLER_IMAGE" \
  --profile google-variant-aggregation --output-dir "$SIMPLER_CONFIG"
orbit bench add-file "$SIMPLER_CONFIG/benchmark.json"
orbit bench tasks simpler-google-variant-aggregation-native --json

python3 -B examples/bench-adapters/embodied/plan.py \
  --reference-source "$GROOT_SOURCE" --reference-file "$SIMPLER_CONFIG/reference.json" \
  --task simpler_env_google/google_robot_move_near \
  --environment-seed 7 --initial-state 0 --initial-state 60 > "$SIMPLER_CONFIG/samples.json"
orbit bench calibrate simpler-google-variant-aggregation-native --policy groot-n17-google \
  --sample-plan "$SIMPLER_CONFIG/samples.json" --budget 20 --json
```

For a fixed sweep, the task catalog exposes `initialStateCount`. Use `--all-initial-states`
with selected tasks to expand every scene and pose, or repeat `--initial-state` for a subset.
The state index selects a grid point and `--environment-seed` seeds the native simulator.
Prepackaged profiles use the existing sum of the environment seed and state index. The fork's
two WidowX small-drawer tasks run at 3 Hz, and their reset also draws from NumPy's process RNG.
Orbit seeds those draws with the same effective scene seed. The other WidowX tasks run at 5 Hz.

## Evaluation conditions

The fixed sweeps use the published native horizons and the source scene presets. Orbit applies the
registered policy's action convention and reads native success. Its 7-D GR00T binding uses native
timed progression in the drawer-placement task at control step 100. The RT-1 and Octo paper
runners also accept a policy terminate prediction, which can advance a subtask earlier.
Orbit's native success reports describe the registered policy and frozen sample plan.

Pass `--policy-termination` for a fixed scene grid to register the RT-1/Octo stopping protocol.
It uses a separate `-stop-native` benchmark name and expects a compatible policy
to return the seven native controller values followed by a termination value. A positive value
advances a non-final subtask before the control step or stops the episode after that step when
already on the final subtask. The last native `done` flag determines success. The policy must
perform any gripper conversion before returning its action.

The existing GR00T checkpoints use the seven-channel wrapper registrations. For ray-traced
settings the policy-termination profile can also be registered with `--disable-rt-denoiser`.
