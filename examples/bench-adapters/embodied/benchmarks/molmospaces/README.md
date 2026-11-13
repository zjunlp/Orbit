# MolmoSpaces manipulation benchmarks

Orbit registers the four DROID Franka manipulation tracks documented for
[MolmoSpaces v0.2.9](https://github.com/allenai/molmospaces/blob/v0.2.9/molmo_spaces/evaluation/ms-bench.md).
The source and benchmark archive version are fixed. Each registration exposes its full
published episode JSON in order. The sample's initial state index selects one exact episode.

| Registration | Official track | Frozen episodes | Control steps |
| --- | --- | ---: | ---: |
| `molmospaces-pick-v1-1-native` | Pick-v1.1 | 1,000 | 455 |
| `molmospaces-pnp-v1-native` | PnP-v1 | 1,000 | 682 |
| `molmospaces-open-v1-native` | Open-v1 | 1,000 | 455 |
| `molmospaces-close-v1-native` | Close-v1 | 915 | 455 |

The reference uses the upstream Pi evaluation seed of 42, 66 ms policy steps, and
2 ms control and simulation steps. The documented MS commands let
`eval_main.py` convert each catalog's duration to control steps. The separate
upstream Pick walkthrough overrides its limit to 500 steps. For a reference
comparison, select the same episode index and step limit in both runners.
The native success predicate controls early stopping and determines the final score.
Open and Close explicitly select the upstream DROID joint-grasp library during
reset so iTHOR objects defined inside a scene can resolve their grasp files.
See the [upstream evaluator](https://github.com/allenai/molmospaces/blob/v0.2.9/molmo_spaces/evaluation/eval_main.py)
and the [native rollout loop](https://github.com/allenai/molmospaces/blob/v0.2.9/molmo_spaces/data_generation/pipeline.py).

The [MolmoBot v2 protocol](https://github.com/allenai/molmospaces/blob/v0.2.9/molmo_spaces/evaluation/mb-bench.md)
adds seven DROID conditions. Each registration exposes 1,000 episodes. The three
Pick-v2 conditions share the same scene catalog.

| Track suffix in `molmospaces-<track>-native` | Renderer | Control steps |
| --- | --- | ---: |
| `pick-v1-5` | Classic | 303 |
| `pick-v2-classic` | Classic | 303 |
| `pick-v2-filament` | Filament | 303 |
| `pick-v2-rand-cam` | Filament | 303 |
| `pnp-v2` | Filament | 606 |
| `pnp-next-to-v2` | Filament | 455 |
| `pnp-color-v2` | Filament | 606 |

Select `--suite mb-v2` when preparing or registering the separate
`molmospaces-mb-v2-assets` bundle. Build the pinned Filament image from the classic
image and pass it as `--filament-image` during registration. The randomized-camera
track declares its own exocentric camera in the observation profile.
The v2 asset preparation also scans the selected scene XMLs and installs the
referenced Objaverse meshes and textures. Keep the bundle outside the checkout;
all seven conditions share the same read-only mount.
Allow time for the first asset fingerprint. When running several episodes, use
Orbit batch execution to verify the bundle once per batch.

```bash
recipe=examples/bench-adapters/embodied/benchmarks/molmospaces/configure_molmospaces.py
python3 -B "$recipe" --source "$MOLMOSPACES_SOURCE" --build-filament orbit/molmospaces:7351388-filament \
  --base-image orbit/molmospaces:7351388
python3 -B "$recipe" --source "$MOLMOSPACES_SOURCE" --suite mb-v2 \
  --prepare-assets orbit/molmospaces:7351388 --assets "$MOLMOBOT_ASSETS"
python3 -B "$recipe" --source "$MOLMOSPACES_SOURCE" --suite mb-v2 \
  --benchmark-image orbit/molmospaces:7351388 --filament-image orbit/molmospaces:7351388-filament \
  --assets "$MOLMOBOT_ASSETS" --output-dir "$MOLMOBOT_CONFIG"
orbit data add molmospaces-mb-v2-assets "$MOLMOBOT_ASSETS"
for config in "$MOLMOBOT_CONFIG"/*/benchmark.json; do
  orbit bench add-file "$config"
done
```

## Build and register

Set the variables below to local paths outside the Orbit source tree. Asset preparation
uses Ai2's resource manager to retrieve the frozen catalogs, robot, scene, object and grasp
archives required by these tracks, including the recorded Objaverse receptacles for
Pick and Place and the Objathor metadata used by Pick and Place and Open. The runtime
image also pins both WordNet corpora used by the native object taxonomy. The resulting
bundle contains regular files and is mounted read-only during evaluation.

```bash
git clone --branch v0.2.9 https://github.com/allenai/molmospaces.git "$MOLMOSPACES_SOURCE"
python3 -B examples/bench-adapters/embodied/benchmarks/molmospaces/configure_molmospaces.py \
  --source "$MOLMOSPACES_SOURCE" --build-tag orbit/molmospaces:7351388
python3 -B examples/bench-adapters/embodied/benchmarks/molmospaces/configure_molmospaces.py \
  --source "$MOLMOSPACES_SOURCE" --prepare-assets orbit/molmospaces:7351388 \
  --assets "$MOLMOSPACES_ASSETS"
python3 -B examples/bench-adapters/embodied/benchmarks/molmospaces/configure_molmospaces.py \
  --source "$MOLMOSPACES_SOURCE" --benchmark-image orbit/molmospaces:7351388 \
  --assets "$MOLMOSPACES_ASSETS" --output-dir "$MOLMOSPACES_CONFIG"

orbit data add molmospaces-ms-v1-assets "$MOLMOSPACES_ASSETS"
for config in "$MOLMOSPACES_CONFIG"/*/benchmark.json; do
  orbit bench add-file "$config"
done
python3 -B examples/bench-adapters/embodied/plan.py \
  --reference-source "$MOLMOSPACES_SOURCE" \
  --reference-file "$MOLMOSPACES_CONFIG/molmospaces-pick-v1-1-native/reference.json" \
  --task pick-v1-1 --initial-state 0 --initial-state 1 > "$MOLMOSPACES_CONFIG/pick-samples.json"
```

The benchmark exposes shoulder and wrist RGB resized by the native Pi preprocessing,
seven arm joint positions, the gripper joint angle and the task instruction. Its Policy
connector accepts eight controls per row. The first seven are absolute arm joint
angles in radians. The last is the native binary gripper command, 0 for open and 255 for closed.
Use a compatible independently registered Policy with eight steps per action chunk.
The upstream [Pi baseline instructions](https://github.com/allenai/molmospaces/blob/v0.2.9/molmo_spaces/evaluation/README.md)
describe the `pi05_droid_jointpos` checkpoint and the required OpenPI fork. A Pi connector
must lowercase the instruction, normalize the gripper angle by 0.824033 with clipping
to [0, 1], and threshold the returned gripper value at 0.5 before emitting 0 or 255.

## Register the OpenPI DROID baseline

The separate Policy uses the [OpenPI fork](https://github.com/omarrayyann/openpi/tree/711487f019e5f03b254d427d4523b1f0805a4814)
and the released `gs://openpi-assets/checkpoints/pi05_droid_jointpos` checkpoint.
Set `DROID_OPENPI_SOURCE` to the pinned checkout and `DROID_WEIGHTS` to the local
checkpoint directory containing `params/` and `assets/`. Use the existing OpenPI JAX
policy image as `OPENPI_POLICY_BASE`. Put the PyPI wheels for `msgpack-numpy==0.4.8`,
`opencv-python-headless==4.11.0.86`, and `pytest==8.4.2` with its dependencies in
`WIRE_WHEELS` for the offline build.

The build exports the OpenPI sources from the pinned commit and adds a manifest to
the image. Configuration generation checks the manifest and the DROID entrypoint.
Rebuild older DROID images with the command below before generating a configuration.

```bash
python3 -B examples/bench-adapters/embodied/policies/openpi/configure_droid.py \
  --source "$DROID_OPENPI_SOURCE" --wire-wheels "$WIRE_WHEELS" \
  --policy-base "$OPENPI_POLICY_BASE" --build-tag orbit/openpi-droid:reference
python3 -B examples/bench-adapters/embodied/policies/openpi/configure_droid.py \
  --reference-file "$MOLMOSPACES_CONFIG/molmospaces-pick-v1-1-native/reference.json" \
  --weights "$DROID_WEIGHTS" --policy-image orbit/openpi-droid:reference \
  --output "$MOLMOSPACES_CONFIG/policy.json"
orbit data add pi05-droid-molmospaces "$DROID_WEIGHTS"
orbit policy add "$MOLMOSPACES_CONFIG/policy.json"
orbit bench calibrate molmospaces-pick-v1-1-native --policy pi05-droid-molmospaces \
  --sample-plan "$MOLMOSPACES_CONFIG/pick-samples.json" --budget 20
```

For Pick-RandCam, generate a separate Policy from the randomized camera
reference. It uses `randomized_zed2_analogue_1` as the exterior view and shares
the existing `pi05-droid-molmospaces` weight dataset and model image. To place
both the policy and Filament simulator on one GPU, pass `--share-gpu` during
Policy generation and allow enough GPU memory for both.

```bash
randcam="$MOLMOBOT_CONFIG/molmospaces-pick-v2-rand-cam-native"
python3 -B examples/bench-adapters/embodied/policies/openpi/configure_droid.py \
  --reference-file "$randcam/reference.json" --weights "$DROID_WEIGHTS" \
  --policy-image orbit/openpi-droid:reference --output "$randcam/policy.json"
orbit policy add "$randcam/policy.json"
python3 -B examples/bench-adapters/embodied/plan.py \
  --reference-source "$MOLMOSPACES_SOURCE" --reference-file "$randcam/reference.json" \
  --task pick-v2-rand-cam --initial-state 0 > "$randcam/samples.json"
orbit bench run molmospaces-pick-v2-rand-cam-native \
  -m model=policy,policyRef=pi05-droid-molmospaces-randcam \
  --sample-plan "$randcam/samples.json" --timeout 55
```
