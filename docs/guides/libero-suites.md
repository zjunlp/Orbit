# LIBERO suite selection

Native LIBERO registrations cover all 130 tasks from the pinned upstream catalog, including
the two LIBERO-100 splits (LIBERO-90 and Long). Each suite uses the same native driver, raw
observation profile, action interpretation and CPU evidence verifier. The suite selects the
task catalog, initial-state assets and horizon.

| Suite | CLI identifier | Tasks | Horizon | OpenPI recipe registration | OFT recipe registration |
| --- | --- | --- | --- | --- | --- |
| Spatial | `libero_spatial` | 10 | 220 | `libero-native` | `libero-oft-native` |
| Object | `libero_object` | 10 | 280 | `libero-object-native` | `libero-oft-object-native` |
| Goal | `libero_goal` | 10 | 300 | `libero-goal-native` | `libero-oft-goal-native` |
| Long | `libero_10` | 10 | 520 | `libero-long-native` | `libero-oft-long-native` |
| LIBERO-90 | `libero_90` | 90 | 400 | `libero-90-native` | `libero-oft-90-native` |

The existing Spatial registration names remain the defaults. Additional suites get their own
names, so adding Object does not overwrite the Spatial catalog. The benchmark-only mode
registers any native suite with a simulator audit.

## Model checkpoints

Matching-checkpoint validation covers Spatial, Object, Goal and Long. The RLinf OpenVLA-OFT
checkpoint also passed native LIBERO-90 calibration on two frozen samples.

| Model | Weights used across suites | Policy registration |
| --- | --- | --- |
| pi05 | The existing official `pi05_libero` checkpoint covers all four suites | `pi05-libero`, or `pi05-libero-shared` with `--share-gpu` |
| GR00T N1.7 | Official matching `libero_spatial/`, `libero_object/`, `libero_goal/`, `libero_10/` subfolders | `groot-n17-libero`, `groot-n17-libero-object`, `groot-n17-libero-goal`, `groot-n17-libero-long` |
| OpenVLA-OFT | The existing Spatial checkpoint, or the official joint Spatial/Object/Goal/Long checkpoint | `openvla-oft-libero-spatial`, or `openvla-oft-libero-combined-{spatial,object,goal,long}` |
| RLinf OpenVLA-OFT | The discrete action-token LIBERO-90 checkpoint | `openvla-oft-rlinf-libero-90` |

Pinned repositories and revisions are in [the GR00T model profile](../../examples/bench-adapters/embodied/profiles/groot-model.json)
and [the OFT model profile](../../examples/bench-adapters/embodied/profiles/openvla-model.json).

The joint OFT checkpoint stores four normalization keys. A configured policy selects exactly
one suite key, records it as `normalizationKey`, and verifies the server's `unnormKey` handshake
before inference. The checkpoint and normalization-file digests alone do not distinguish those
four policies. Older policy snapshots without this optional field retain their original meaning.
No normalization key is guessed from observation shapes or task names at runtime.

A different checkpoint is a different model condition: the joint OFT model does not replace
or inherit the verification status of the independently trained Spatial checkpoint. GR00T
continues to use the existing OpenPI-pinned LIBERO runtime and recipe; OFT uses its explicit
recipe. These remain distinct from full official-runtime or published-score equivalence.

## Register a suite

Keep sources, weights, generated configuration and audit outputs outside the checkout. Set the
local variables used below to the corresponding locations. Follow the image and source setup in
[the OpenPI runtime build](../../examples/bench-adapters/embodied/benchmarks/libero/README.md#reference-and-assets),
[GR00T setup](../../examples/bench-adapters/embodied/policies/groot/README.md) and
[OpenVLA-OFT setup](../../examples/bench-adapters/embodied/policies/openvla-oft/README.md).

Register LIBERO-90 using the pinned OpenPI simulator image:

```bash
mkdir -p "$LOCAL_CONFIG"
python3 examples/bench-adapters/embodied/benchmarks/libero/audit.py \
  --reference-source "$OPENPI_SOURCE" --benchmark-image "$LIBERO_SIM_IMAGE" \
  > "$LOCAL_CONFIG/libero-90-audit.json"
python3 examples/bench-adapters/embodied/benchmarks/libero/configure.py --benchmark-only \
  --audit "$LOCAL_CONFIG/libero-90-audit.json" --reference-source "$OPENPI_SOURCE" \
  --suite libero_90 --output-dir "$LOCAL_CONFIG/libero-90"
orbit bench add-file "$LOCAL_CONFIG/libero-90/benchmark.json"
orbit bench tasks libero-90-native --json
```

Use `plan.py --suite libero_90` with task IDs from this registration. Its 400-step horizon
comes from the pinned OpenPI evaluator. The native policy evaluation uses frozen initial states
and the LIBERO success signal.

Use `SUITE=libero_object`, `libero_goal` or `libero_10` in these model setup examples:

```bash
PYTHONPATH=examples/sdk python3 examples/bench-adapters/embodied/benchmarks/libero/configure.py \
  --audit "$PI05_AUDIT" --reference-source "$OPENPI_SOURCE" --suite "$SUITE" \
  --share-gpu --output-dir "$LOCAL_CONFIG/pi05/$SUITE"

python3 examples/bench-adapters/embodied/policies/groot/fetch_groot.py \
  --models libero_object libero_goal libero_10 backbone \
  --source modelscope --output-dir "$GROOT_ASSETS"
PYTHONPATH=examples/sdk python3 examples/bench-adapters/embodied/policies/groot/configure_groot.py \
  --reference-source "$GROOT_SOURCE" --benchmark-source "$OPENPI_SOURCE" \
  --weights "$GROOT_ASSETS" --profile libero --suite "$SUITE" --share-gpu \
  --policy-image orbit/groot-policy:reference --benchmark-image orbit/libero-zmq:reference \
  --output-dir "$LOCAL_CONFIG/groot/$SUITE"

python3 examples/bench-adapters/embodied/policies/openvla-oft/fetch_openvla.py --model combined \
  --output-dir "$OFT_COMBINED_WEIGHTS"
PYTHONPATH=examples/sdk python3 examples/bench-adapters/embodied/policies/openvla-oft/configure_openvla.py \
  --reference-source "$OPENVLA_SOURCE" --benchmark-source "$OPENPI_SOURCE" \
  --weights "$OFT_COMBINED_WEIGHTS" --model combined --suite "$SUITE" --share-gpu \
  --policy-image orbit/openvla-oft-policy:reference --benchmark-image orbit/libero-zmq:reference \
  --output-dir "$LOCAL_CONFIG/oft/$SUITE"
```

The pi05 audit must cover its checkpoint and both runtime images. Its shared-GPU policy uses a
separate name, preserving the default policy for CPU-rendered registrations. pi05 and GR00T
produce the same native benchmark registration when source, suite, image and rendering options
are equal. Register one such benchmark definition and the desired independent policies. Their
named weight datasets are `pi05-libero` and `groot-n17`; the joint OFT checkpoint uses
`openvla-oft-libero-combined`.

For example, after configuring OFT for Object:

```bash
orbit data add openvla-oft-libero-combined "$OFT_COMBINED_WEIGHTS"
orbit policy add "$LOCAL_CONFIG/oft/libero_object/policy.json"
orbit bench add-file "$LOCAL_CONFIG/oft/libero_object/benchmark.json"
python3 examples/bench-adapters/embodied/plan.py --reference-source "$OPENPI_SOURCE" \
  --reference-file examples/bench-adapters/embodied/profiles/openvla-libero.json \
  --suite libero_object --task "libero_object:$TASK_NAME" \
  --initial-state 0 --initial-state 1 --environment-seed 0 \
  > "$LOCAL_CONFIG/oft/libero_object/samples.json"
orbit bench calibrate libero-oft-object-native --policy openvla-oft-libero-combined-object \
  --sample-plan "$LOCAL_CONFIG/oft/libero_object/samples.json" --budget 20 --json
```

OpenPI/GR00T plans use `reference.json`, environment seed 7 and five-step replanning. OFT plans
use `profiles/openvla-libero.json`, environment seed 0 and eight-step replanning. Task and initial
state identities are frozen in the plan. The different recipes are different evaluation conditions;
matching task names alone does not permit paired comparisons or merging.

## Verification scope

Catalog and native reset/control coverage are separate from model-path validation. Routine
onboarding uses a bounded representative batch for each newly supported model/suite combination,
independent CPU verification, selected rescore and resource cleanup. It does not certify every
model/task pair, whole-suite success rates, official numerical parity or statistical equivalence.
These larger studies require their own declared scope and compute budget.
