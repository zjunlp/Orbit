# HSSD-OV

Orbit exposes all 1,751 published object-goal episodes from 43 scenes. It uses the [StopWatch HSSD-OV protocol](https://github.com/amazon-far/stopwatch/tree/bda73cbab833dcb72af23d24067bad2b56ca5ef1) for scene setup, the Habitat Stretch camera and native movement. Each episode has the original category, starting pose and accepted instance viewpoints. The action set is STOP, forward 25 cm, turn left 30° and turn right 30°. The horizon is 500 steps. Success requires STOP at a geodesic distance strictly below 0.25 m. Orbit additionally reports final distance and SPL. The rebuilt navmesh must match the publisher’s per-scene digest. CPU verification checks that turns and forward motion match the recorded poses, replays collision sliding on the navmesh, and recomputes distances and scoring. In Web, Trial shows first-person RGB, the action IDs and the recorded positions.

## Prepare, build and register

Set `STOPWATCH_SOURCE` to the pinned checkout linked above. Clone [Habitat-Sim](https://github.com/facebookresearch/habitat-sim/tree/2bc5b4573b37202cb44b771ded34d5992a93f795) with its pinned C++ submodules into `HABITAT_SIM`, and [Habitat-Lab](https://github.com/facebookresearch/habitat-lab/tree/8c403d6645bd320652ff44c2fb5185f6c208c8ab) into `HABITAT_LAB`. Set `IMATH_SOURCE` to [Imath v3.1.9](https://github.com/AcademySoftwareFoundation/Imath/tree/d690a3fcff4e877ead5ae56c7e964595ade8a35e), the version requested by Habitat-Sim's OpenEXR submodule. The headless build uses EGL.

Preparation checks the required scene files and the deterministic outputs against the [pinned manifest digest](release.json) before writing derived files. The pin uses source files verified against Git blob IDs or LFS SHA-256 values from the [fixed HSSD revision](https://huggingface.co/datasets/hssd/hssd-hab/tree/4369cb9876214c7fbebcf552eb532380e4d287e4). Registration checks the same manifest digest, and Solve verifies the files required by the selected scenes. Run `--prepare-assets` again to refresh an older manifest from existing source files.

```bash
git -C "$HABITAT_SIM" submodule update --init --recursive -- \
  src/deps/{assimp,corrade,magnum,magnum-bindings,magnum-integration,magnum-plugins,openexr,pybind11,rapidjson,recastnavigation,tinyobjloader,zstd}
hf download Amazon-FAR/stopwatch-data --repo-type dataset \
  --revision f1a5d5539b0c9584b5ed522a5d5578514444c684 --local-dir "$HSSD_ASSETS" \
  --include 'eval/hssdov/**' --include 'protocol/instance_viewpoints/hssd/val/**' \
  --include 'vocab/objectnav_goal_sets.json'
hf download hssd/hssd-hab --repo-type dataset --revision 4369cb9876214c7fbebcf552eb532380e4d287e4 \
  --local-dir "$HSSD_ASSETS/scenes/hssd-hab" --include 'objects/**' --include 'stages/**' \
  --include 'scenes/*' --include 'semantics/*' --include 'hssd-hab.scene_dataset_config.json'

config=examples/bench-adapters/embodied/benchmarks/hssd-ov/configure_hssd_ov.py
python3 -B "$config" --prepare-assets --assets "$HSSD_ASSETS"
python3 -B "$config" --source "$STOPWATCH_SOURCE" --habitat-sim "$HABITAT_SIM" \
  --habitat-lab "$HABITAT_LAB" --imath "$IMATH_SOURCE" --build-tag orbit/hssd-ov:reference
python3 -B "$config" --source "$STOPWATCH_SOURCE" --assets "$HSSD_ASSETS" \
  --benchmark-image orbit/hssd-ov:reference --output-dir "$HSSD_CONFIG"

orbit data add hssd-ov "$HSSD_ASSETS"
registration="$HSSD_CONFIG/hssd-ov"
orbit bench add-file "$registration/benchmark.json"
python3 -B examples/bench-adapters/embodied/plan.py --reference-source "$STOPWATCH_SOURCE" \
  --reference-file "$registration/reference.json" --all-tasks --all-initial-states \
  > "$registration/samples.json"
```

See the [LightNav-0 guide](../../policies/lightnav-0/README.md) to run the policy.
