# EB-Navigation

This registration exposes all 300 public EB-Navigation episodes, with 60 in each of
`base`, `common_sense`, `complex_instruction`, `visual_appearance` and `long_horizon`.
Each task freezes the published scene, start pose, target and instruction. The native simulator
applies eight discrete actions and ends at a horizontal distance of 1 m or less from the target,
or after 20 steps. Orbit verifies this rule against the saved controls and positions on CPU.
The report shows overall and per-subset success, final distance and steps. The Trial timeline
synchronizes the raw first-person and overhead recordings with `navigation_views`, a video
of the annotated composite passed to the policy before each action. It also shows position
and action ID. Older runs display the raw views they recorded.

The `eb-navigation-seenav` profile uses the SeeNav visual prompting recipe. The model sees a
first-person image and an aligned overhead image with simulator-supplied target annotations and
projected actions. Both models use these same inputs, feedback and prompts. This evaluates
object-goal navigation with visual prompting. The original [EmbodiedBench task catalog](https://github.com/EmbodiedBench/EmbodiedBench/tree/9be4e980e9cd6bcb38373cd4aab7c32724bdd401/embodiedbench/envs/eb_navigation)
and [SeeNav reference](https://github.com/WzcTHU/SeeNav-Agent/tree/7ed6a59052701951bdb2c7d51dd6d9103219cf3e)
are pinned separately.

## Build and register

Clone the two pinned repositories above into `$EB_NAV_SOURCE` and `$SEENAV_SOURCE`.
Save the official
[AI2-THOR 5.0.0 CloudRendering ZIP](https://s3-us-west-2.amazonaws.com/ai2-thor-public/builds/thor-CloudRendering-f0825767cd50d69f666c7f282e54abfe58f1e917.zip)
as `$EB_NAV_UNITY`. The build checks its digest and copies the scenes into the simulator image.
The runtime uses headless Vulkan with the NVIDIA graphics driver. Build and registration default
to an Ubuntu 24.04 base image.

```bash
config=examples/bench-adapters/embodied/benchmarks/eb-navigation/configure_eb_navigation.py
python3 -B "$config" --source "$EB_NAV_SOURCE" --seenav-source "$SEENAV_SOURCE" \
  --unity-zip "$EB_NAV_UNITY" --build-tag orbit/eb-navigation:reference
python3 -B "$config" --source "$EB_NAV_SOURCE" --seenav-source "$SEENAV_SOURCE" \
  --benchmark-image orbit/eb-navigation:reference --output-dir "$EB_NAV_CONFIG"

registration="$EB_NAV_CONFIG/eb-navigation-seenav"
orbit bench add-file "$registration/benchmark.json"
python3 -B examples/bench-adapters/embodied/plan.py --reference-source "$EB_NAV_SOURCE" \
  --reference-file "$registration/reference.json" --all-tasks --all-initial-states \
  > "$registration/samples.json"
```

For a short paired run, replace `--all-tasks --all-initial-states` with
`--task base:01 --task long_horizon:01 --initial-state 0`. Follow the
[SeeNav model setup](../../policies/seenav/README.md) to register both policy weights and run the plan.
