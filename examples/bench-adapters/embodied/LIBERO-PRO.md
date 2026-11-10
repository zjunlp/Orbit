# Native LIBERO-PRO

The initial [LIBERO-PRO release](https://github.com/Zxy-MLlab/LIBERO-PRO/tree/eafdb809426b13153aa1e4c42d6601844217dfec)
defines twenty leaderboard conditions. Each of Spatial, Object, Goal and Long has ten task
entries under each of the Object, Position, Language, Task and Environment protocols.
The native driver sends the instruction parsed from the prepared BDDL. This keeps the
instruction synchronized with the perturbed goal even when a task's filename is unchanged.

The image runs the upstream perturbators with a fixed preparation seed. Preparation repairs
one missing fixture key and three malformed goal conjunctions in the pinned release. Object
choices use the released alternatives supported by the native registry and the task's regions.
The catalog marks whether the upstream transformation changed each task. For example, some
Environment entries already use the table selected by the upstream transformation.

The release generates reset states from the perturbed BDDL. Orbit freezes the BDDL and exposes
50 indexed samples per task. Each index selects a deterministic native constructor seed and
uses the resulting simulator state for reset. The prepared BDDL digest and actual reset-state
digest are both available in the evidence. These generated states are specific to Orbit's
seeded recipe. Use the same preparation seed and initial-state plan for comparisons.

## Build and register

Use a clean checkout at the pinned revision and a local LIBERO base image with MuJoCo, the
OpenPI client and MsgPack. The LIBERO ZMQ image used in the
[OpenVLA-OFT setup](OPENVLA.md) provides those dependencies. Set the source, base image
and output directory variables before running from the Orbit checkout.

```bash
python3 -B examples/bench-adapters/embodied/configure_libero_pro.py \
  --source "$LIBERO_PRO_SOURCE" --base-image "$LIBERO_RUNTIME" \
  --build-tag orbit/libero-pro:reference
python3 -B examples/bench-adapters/embodied/configure_libero_pro.py \
  --source "$LIBERO_PRO_SOURCE" --base-image "$LIBERO_RUNTIME" \
  --benchmark-image orbit/libero-pro:reference --output-dir "$LIBERO_PRO_CONFIG"

config="$LIBERO_PRO_CONFIG/spatial-language"
orbit bench add-file "$config/benchmark.json"
orbit bench tasks libero-pro-spatial-language-native --json
python3 -B examples/bench-adapters/embodied/plan.py --reference-source "$LIBERO_PRO_SOURCE" \
  --reference-file "$config/reference.json" --task "$TASK_ID" --initial-state 0 \
  > "$config/samples.json"
orbit bench run libero-pro-spatial-language-native \
  --method oft=policy,policyRef=openvla-oft-libero-spatial --sample-plan "$config/samples.json"
```

Use the matching original LIBERO suite normalization key for the OFT Policy. For a Policy
registered with `gpusOf: main`, regenerate the benchmark with `--share-gpu` to use EGL and
reserve the simulator's part of the shared GPU budget. Use `--all-tasks --all-initial-states`
to enumerate the entire available condition.

## Run the preparation regressions

Run from the Orbit checkout with the pinned simulator image. The tests use its released
source and native object registry to check the YAML repairs, candidate filtering and
reproducibility of the 200 prepared BDDL entries.

```bash
docker run --rm --network none --label orbit.task=embodied-libero-pro-test \
  --mount "type=bind,src=$PWD/examples/bench-adapters/embodied,dst=/orbit-tests,readonly" \
  -e MUJOCO_GL=osmesa -e PYOPENGL_PLATFORM=osmesa orbit/libero-pro:reference \
  -B /orbit-tests/test_prepare_libero_pro.py
```
