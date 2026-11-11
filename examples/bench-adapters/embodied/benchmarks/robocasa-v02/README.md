# Original RoboCasa v0.2

Orbit exposes the 24 atomic manipulation tasks as an independent native Policy benchmark. The
recipe uses PandaOmron, 128-pixel left and wrist RGB, and the native language instruction. It
holds the mobile base and torso fixed by padding the seven arm and gripper commands with five
zeroes. The environment uses object split B and five fixed kitchen layout and style pairs.
Each task runs to the first native success or its dataset registry horizon at 20 Hz.
Rescore checks the padded command and stop point from the saved trajectory.
[Original RoboCasa](https://robocasa.ai/) · [Atomic evaluation recipe](https://github.com/allenai/vla-evaluation-harness/releases/tag/v0.5.0)

The registration covers the atomic recipe. The original release also includes navigation and
composite tasks with different control needs. RoboCasa365 is a separate benchmark.

## Build and register

Set the source variables to clean checkouts of RoboCasa
`756598a5be52e052339bb2d957426e39015c2afb` and robosuite
`1a8701b90c07c6595ace4af9935d7c5ebe1baed3`. Store generated assets and registrations outside
the checkout. Prepare the original v0.2 asset tree using the source's asset downloader or
extract it from the archived public image below. The configurator checks the placement sites
used by v0.2 and fingerprints the asset tree. The RoboCasa365 asset archives use a different
object XML format.
The build command exports the pinned source commits. The configurator checks the image's
build manifest and entrypoint before freezing its ID.
[Original asset script](https://github.com/robocasa/robocasa/blob/756598a5be52e052339bb2d957426e39015c2afb/robocasa/scripts/download_kitchen_assets.py) · [Archived image release](https://github.com/allenai/vla-evaluation-harness/releases/tag/v0.8.0)

```bash
asset_image=ghcr.io/worv-ai/vla-evaluation-harness-public/robocasa@sha256:fb6690e29998f38cb8a3bd145bd4210379825fb86cec502f154dc40711e1b295
docker pull "$asset_image"
asset_container=$(docker create --label orbit.task=robocasa-v02-assets "$asset_image")
docker cp "$asset_container:/app/robocasa/robocasa/models/assets" "$ROBOCASA_V02_ASSETS"
docker rm "$asset_container"

python3 -B examples/bench-adapters/embodied/native_runtime.py robocasa-v02 \
  --source "$ROBOCASA_V02_SOURCE" --robosuite-source "$ROBOSUITE_150_SOURCE" \
  --tag orbit/robocasa-v02:reference

python3 -B examples/bench-adapters/embodied/benchmarks/robocasa-v02/configure_robocasa_v02.py \
  --source "$ROBOCASA_V02_SOURCE" --robosuite-source "$ROBOSUITE_150_SOURCE" \
  --assets "$ROBOCASA_V02_ASSETS" --benchmark-image orbit/robocasa-v02:reference \
  --output-dir "$ROBOCASA_V02_CONFIG"

orbit data add robocasa-v02-assets "$ROBOCASA_V02_ASSETS"
orbit bench add-file "$ROBOCASA_V02_CONFIG/benchmark.json"
orbit bench tasks robocasa-v02-atomic-native --json
```

The simulator renders with CPU OSMesa and reserves 20 GB of system memory for scene construction.
Sample index `i` uses the supplied environment seed plus
`i`. The default base seed is 7. Expanding all initial states produces 50 seeded samples per
task. The benchmark, sample plan and Policy are registered separately.

```bash
python3 -B examples/bench-adapters/embodied/plan.py --reference-source "$ROBOCASA_V02_SOURCE" \
  --reference-file "$ROBOCASA_V02_CONFIG/reference.json" \
  --all-tasks --all-initial-states > "$ROBOCASA_V02_CONFIG/samples.json"
```

A Policy can use `policy-ws` with the observation keys and seven-component controller from
`benchmarkProfile`. Follow the [Policy registration template](../../../../../docs/guides/embodied-onboarding.md).
