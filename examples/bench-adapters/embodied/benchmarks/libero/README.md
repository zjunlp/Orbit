# LIBERO and OpenPI π₀.₅

Build and register the pinned LIBERO simulator and optionally the OpenPI checkpoint, then run a frozen sample plan.
For other suites or checkpoints, see [LIBERO suite selection](../../../../../docs/guides/libero-suites.md).

## Reference and assets

`reference.json` fixes source revisions, input file hashes, camera/state processing, horizons,
settle steps and action replanning. The public checkpoint and normalization content are pinned separately from source; a profile alone
does not attest that the local images or calibration passed. `audit.py` prints a machine-independent report;
store that report, registrations, weights and experiment outputs outside the repository.

Set `LIBERO_SOURCE`, `OPENPI_SOURCE`, `CHECKPOINT_DIR`, `LOCAL_CONFIG` and `AUDIT_FILE` in your local environment.
LIBERO supplies the simulator, task catalog and initial states. OpenPI supplies the pinned
dependency recipe, client and reference evaluator. Check out the references separately. The
OpenPI checkout can leave its submodules uninitialized.

Build the dependency base, then add the source packages to the runtime image. An existing
dependency image built from the same pinned sources can also serve as `BENCHMARK_BASE`.

```bash
git clone https://github.com/Lifelong-Robot-Learning/LIBERO "$LIBERO_SOURCE"
git -C "$LIBERO_SOURCE" checkout --detach f78abd68ee283de9f9be3c8f7e2a9ad60246e95c
git clone https://github.com/Physical-Intelligence/openpi "$OPENPI_SOURCE"
git -C "$OPENPI_SOURCE" checkout --detach 215abfb217dbac7d5f1273282331b9b1866c0479

python3 examples/bench-adapters/embodied/benchmarks/libero/build_base.py \
  --reference-source "$OPENPI_SOURCE" --libero-source "$LIBERO_SOURCE" \
  --component benchmark --tag orbit/libero-deps:reference
docker build --label orbit.task=embodied-eval --build-context openpi="$OPENPI_SOURCE" \
  --build-context libero="$LIBERO_SOURCE" \
  --build-arg BENCHMARK_BASE=orbit/libero-deps:reference \
  -f examples/bench-adapters/embodied/benchmarks/libero/benchmark.Dockerfile -t orbit/libero-native:reference .
```

The benchmark alone can be prepared and registered with the following commands. Use the same
audit file in Orbit's built-in LIBERO preparation recipe.

```bash
python3 examples/bench-adapters/embodied/benchmarks/libero/audit.py --reference-source "$OPENPI_SOURCE" \
  --libero-source "$LIBERO_SOURCE" --benchmark-image orbit/libero-native:reference > "$AUDIT_FILE"
python3 examples/bench-adapters/embodied/benchmarks/libero/configure.py --audit "$AUDIT_FILE" \
  --libero-source "$LIBERO_SOURCE" --benchmark-only --output-dir "$LOCAL_CONFIG"
```

To prepare the optional π₀.₅ policy at the same time, build its image and include it and the
checkpoint in the audit.

```bash
docker build --label orbit.task=embodied-eval -t orbit/openpi-deps:reference \
  -f "$OPENPI_SOURCE/scripts/docker/serve_policy.Dockerfile" "$OPENPI_SOURCE"
docker build --label orbit.task=embodied-eval --build-context openpi="$OPENPI_SOURCE" \
  --build-arg POLICY_BASE=orbit/openpi-deps:reference \
  -f examples/bench-adapters/embodied/policies/openpi/policy.Dockerfile -t orbit/openpi-policy:reference .

python3 examples/bench-adapters/embodied/benchmarks/libero/audit.py --reference-source "$OPENPI_SOURCE" \
  --libero-source "$LIBERO_SOURCE" --checkpoint "$CHECKPOINT_DIR" --benchmark-image orbit/libero-native:reference \
  --policy-image orbit/openpi-policy:reference > "$AUDIT_FILE"
python3 examples/bench-adapters/embodied/benchmarks/libero/configure.py --audit "$AUDIT_FILE" \
  --libero-source "$LIBERO_SOURCE" --output-dir "$LOCAL_CONFIG"
```

Inspect the resolved image IDs and build inputs in the audit. `configure.py` uses those immutable
IDs and measured checkpoint/normalization digests, not floating image tags. The model launcher
checks both asset digests before loading and returns them in the native WebSocket handshake.
The initial reference supports JAX OpenPI policies, with service-scoped key 0.

If container-side Python or Git downloads fail, `build_base.py` accepts an existing standalone
Python (3.8.20 for the benchmark, 3.11.9 for the policy), and optionally `--lerobot-source` for an
existing checkout containing OpenPI's locked dependency commit. It copies the exact commit into
a temporary build context; it does not switch the checkout or rewrite `uv.lock`. For Python 3.8
it uses the runtime lock's setuptools 75.3.0 when building source distributions, avoiding an
unconstrained newer build backend. Build labels record the source recipe, effective recipe and
Python version. These provisioning changes are separate from evaluation protocol parity.

```bash
python3 examples/bench-adapters/embodied/benchmarks/libero/build_base.py --reference-source "$OPENPI_SOURCE" \
  --libero-source "$LIBERO_SOURCE" --component benchmark --python "$PYTHON38" --tag orbit/libero-deps:reference
python3 examples/bench-adapters/embodied/benchmarks/libero/build_base.py --reference-source "$OPENPI_SOURCE" \
  --component policy --python "$PYTHON3119" --lerobot-source "$LEROBOT_SOURCE" \
  --tag orbit/openpi-deps:reference
```

## Register and submit

```bash
orbit data add pi05-libero "$CHECKPOINT_DIR"
orbit policy add "$LOCAL_CONFIG/policy.json"
orbit bench add-file "$LOCAL_CONFIG/benchmark.json"
orbit bench tasks libero-native --json

python3 examples/bench-adapters/embodied/plan.py --libero-source "$LIBERO_SOURCE" \
  --task "libero_spatial:$TASK_NAME" --initial-state 0 --initial-state 1 \
  > "$LOCAL_CONFIG/samples.json"
orbit bench run libero-native --method pi05=policy,policyRef=pi05-libero \
  --sample-plan "$LOCAL_CONFIG/samples.json"
```

`--sample-plan` and `--seeds` are mutually exclusive. A planned trial has `sampleRef` and no
legacy `seed`. The plan stores initial-state asset identity, environment seed, policy seed and
repetition separately. Different samples never become repeats just because their task matches.
Mapping errors fail before job creation; the resolved mapping and policy definition are frozen.
Changing the adapter or SDK requires explicitly regenerating and registering the benchmark
configuration. Each solve and verify output archives its own source bundle and digest; rescore
records the new verifier while retaining the original solve implementation and evidence.
Generated registrations embed `reference`. Hand-written registrations may omit it to use the
packaged `reference.json`; every phase still requires its content to match the registered
`profileDigest`, including saved-output verification and scoring.

With one episode per solve Run, each Trial starts a fresh policy service with JAX key 0.
Fixed sequential solve batches use `--batch-size` and advance one service-scoped random stream
in frozen sample order. The default OpenPI simulator configuration uses CPU OSMesa.
Renderer changes are explicit evaluation conditions and need their own reference checks.
Use matching service streams and episode order for upstream multi-episode comparisons.

Add `--batch-size 8` to the planned `orbit bench run` command to load the model once for each
fixed group of up to eight compatible episodes. Each episode retains its own Trial, native evidence
and CPU verifier. Cancelling the shared Run stops unfinished episodes and preserves independently
verifiable completed results. See [batch execution and recovery](../../../../../docs/guides/embodied-batches.md).

Saved evidence includes requested action chunks (plus the raw model output when a named
conversion applies), executed controls with source observation and
chunk indexes, native verdict, required state, timing, the contract and resolved binding. Optional
compressed video is separate from scoring evidence; raw camera tensors are not retained by
default. A score of zero from reaching the horizon is valid, while model/environment failures
retain their closed Orbit failure kind and the upstream error-inclusive denominator.

## Sampled reference comparison

`parity_plan.py` freezes a comparison against a saved real GPU solve. Export that Run's JSON
with `orbit show "$SOLVE_RUN" --json` and locate its saved output directory. The candidate must
be the first task and first initial state of the selected official suite, with environment seed 7,
fresh service-scoped JAX key 0, and the unchanged SDK/driver. The builder checks pinned source
files and records the comparison code, immutable runtime images and original evidence digest.

```bash
python3 -B examples/bench-adapters/embodied/benchmarks/libero/parity_plan.py \
  --reference-source "$OPENPI_SOURCE" --libero-source "$LIBERO_SOURCE" --orbit-run "$SOLVE_RUN_JSON" \
  --orbit-output "$SOLVE_OUTPUT" --output-dir "$PARITY_CONFIG"
```

The destination must be new. Submit `deterministic-run.json`, then `rollout-run.json`, using
the existing authenticated `POST /api/v1/runs` API or `OrbitClient.submit`. Both use the normal
Run/resource lifecycle. The first needs no model or GPU; the second starts the original frozen
model service with its recorded resource requirements and read-only weights mount.

The official `eval_libero` function runs unchanged. Observers wrap its environment/client and
capture counters at video output, after the complete first episode and its denominator update.
Execution stops there, preserving the official first-episode prefix. No task catalog, action,
observation, success condition or model RNG is substituted in the real-policy comparison.
The deterministic negative explicitly substitutes a zero-action fixture.

The frozen checks require exact array dtype/shape/values and per-step native physics, raw camera,
action, reward and termination fingerprints. Two initial states receive the same declared fixed
action sequence. A native zero-action episode must reach the official horizon. The real-policy
path compares every full predicted chunk against the original real Orbit solve and replays
those actions through the SDK, checking its requests and recorded states against the official
trace. Reconstructed SDK requests are labelled as replay evidence. Wall/inference timing and
optional video resolution are excluded. Failures exit nonzero and write `parity-result.json`.

Each Run saves the frozen plan, source bundle and comparison outputs. A passing sampled check
does not establish full-suite statistical equivalence or later-episode random-stream parity;
those require a separately declared sampling/stream plan and shared-batch support.

For a stricter interface control, `--paired-runtime --baseline-plan "$BASELINE_PLAN"` creates
an audit-only model service with two native WebSocket servers. They share immutable weights and
one compiled sampler; each starts with its own key-0 stream. The official loop and the production
SDK driver perform real inference, and observers compare both live request packets and complete
predicted chunks. No action replay replaces inference in this mode. Both streams are created at
service startup; no remote RNG-reset operation is added to the production connector.

The parent plan links the earlier criteria and rejects changed samples, identities or numeric
tolerances. This control tests protocol equivalence under a common numerical implementation.
Keep an independently compiled process comparison as a separate result: a failed bitwise check
does not become passed when the shared-runtime control succeeds. It also does not provide a
statistical equivalence claim about independently started services. This audit service is not
production shared-batch or model-pool support.
