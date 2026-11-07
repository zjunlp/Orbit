# Native embodied benchmarks and independent policies

Experimental D1 implementation. Development checks include real π₀.₅ checkpoint positives on
CPU and GPU, native-environment negatives and saved-output rescore/cleanup. Deterministic
reference checks and a sampled real protocol control with shared compiled weights passed.
Bitwise comparison across independent GPU processes failed; full-suite statistical equivalence
remains unverified. See the task records for validation details.
The existing vla-eval registrations remain separate.

The additional GR00T connector reuses the same native LIBERO benchmark and supports native
SimplerEnv WidowX and Google Robot. Provisioning and explicit evaluation conditions are in [GR00T.md](GR00T.md).
OpenVLA-OFT uses the same native LIBERO implementation with its own inference service and
eight-step evaluation recipe; see [OPENVLA.md](OPENVLA.md).
All three model families support Spatial, Object, Goal and Long through explicit suite and
checkpoint selection; see [LIBERO suites](../../../docs/guides/libero-suites.md).
RoboCasa365 Atomic-Seen uses its original Gymnasium environments and a separate OpenPI service
with the published RoboCasa π₀.₅ checkpoint. The GR00T N1.5 recipe uses the same native driver
with RoboCasa 1.0.1 and its own Policy registration. See [RoboCasa365 setup](ROBOCASA365.md).
For new endpoints, see the [onboarding templates](../../../docs/guides/embodied-onboarding.md)
and [compatibility matrix](../../../docs/guides/embodied-compatibility.md).

The benchmark adapter lists native tasks and runs one or more frozen samples per solve Run.
Orbit adds the independently registered model service and leases both roles together. Verify
reads saved evidence in a separate CPU-only Run; it never starts the model or simulator.

## Reference and assets

`reference.json` fixes source revisions, input file hashes, camera/state processing, horizons,
settle steps and action replanning. The public checkpoint and normalization content are pinned separately from source; a profile alone
does not attest that the local images or calibration passed. `audit.py` prints a machine-independent report;
store that report, registrations, weights and experiment outputs outside the repository.

Set `OPENPI_SOURCE`, `CHECKPOINT_DIR`, `LOCAL_CONFIG` and `AUDIT_FILE` in your local environment.
The source must match the pinned OpenPI checkout, including its own LIBERO submodule. The
standalone LIBERO checkout can have a different revision and is not substituted automatically.

Build the upstream dependency bases from the audited source, then bake in the source packages
that upstream's development images normally expect as bind mounts:

```bash
docker build --label orbit.task=embodied-eval -t orbit/libero-deps:reference \
  -f "$OPENPI_SOURCE/examples/libero/Dockerfile" "$OPENPI_SOURCE"
docker build --label orbit.task=embodied-eval --build-context openpi="$OPENPI_SOURCE" \
  --build-arg BENCHMARK_BASE=orbit/libero-deps:reference \
  -f examples/bench-adapters/embodied/benchmark.Dockerfile -t orbit/libero-native:reference .

docker build --label orbit.task=embodied-eval -t orbit/openpi-deps:reference \
  -f "$OPENPI_SOURCE/scripts/docker/serve_policy.Dockerfile" "$OPENPI_SOURCE"
docker build --label orbit.task=embodied-eval --build-context openpi="$OPENPI_SOURCE" \
  --build-arg POLICY_BASE=orbit/openpi-deps:reference \
  -f examples/bench-adapters/embodied/policy.Dockerfile -t orbit/openpi-policy:reference .

python3 examples/bench-adapters/embodied/audit.py --reference-source "$OPENPI_SOURCE" \
  --checkpoint "$CHECKPOINT_DIR" --benchmark-image orbit/libero-native:reference \
  --policy-image orbit/openpi-policy:reference > "$AUDIT_FILE"
python3 examples/bench-adapters/embodied/configure.py --audit "$AUDIT_FILE" \
  --reference-source "$OPENPI_SOURCE" --output-dir "$LOCAL_CONFIG"
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
python3 examples/bench-adapters/embodied/build_base.py --reference-source "$OPENPI_SOURCE" \
  --component benchmark --python "$PYTHON38" --tag orbit/libero-deps:reference
python3 examples/bench-adapters/embodied/build_base.py --reference-source "$OPENPI_SOURCE" \
  --component policy --python "$PYTHON3119" --lerobot-source "$LEROBOT_SOURCE" \
  --tag orbit/openpi-deps:reference
```

## Register and submit

```bash
orbit data add pi05-libero "$CHECKPOINT_DIR"
orbit policy add "$LOCAL_CONFIG/policy.json"
orbit bench add-file "$LOCAL_CONFIG/benchmark.json"
orbit bench tasks libero-native --json

python3 examples/bench-adapters/embodied/plan.py --reference-source "$OPENPI_SOURCE" \
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

D1 starts a fresh policy service for every trial. The stock OpenPI protocol cannot reset its
JAX random stream: independently running a later episode does not prove equivalence to the
upstream multi-episode stream. Fixed sequential solve batches are available through `--batch-size`;
their service-scoped random stream advances in frozen sample order. Broader compatibility and
automatic direct mappings remain future work. The OpenPI simulator configuration uses CPU OSMesa;
renderer changes are explicit conditions and need their own reference checks.

Add `--batch-size 8` to the planned `orbit bench run` command to load the model once for each
fixed group of up to eight compatible episodes. Each episode retains its own Trial, native evidence
and CPU verifier. Cancelling the shared Run stops unfinished episodes and preserves independently
verifiable completed results. See [batch execution and recovery](../../../docs/guides/embodied-batches.md).

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
python3 -B examples/bench-adapters/embodied/parity_plan.py \
  --reference-source "$OPENPI_SOURCE" --orbit-run "$SOLVE_RUN_JSON" \
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

## SDK checks

Use separate Python 3.8 and 3.11 environments with NumPy and the audited `openpi-client` package.
The connector additionally needs Pillow, MsgPack and `websockets` (13.1 supports both versions).
GR00T transport checks also need `pyzmq==26.2.0`, `msgpack==1.1.0` and `msgpack-numpy==0.4.8`.
Set `PYTHONPATH=examples/sdk` when running from the repository root.

```bash
python -B -m unittest discover -s examples/sdk -p 'test_*.py' -v
```

These checks include binary WebSocket and ZeroMQ round trips with explicitly synthetic policy
servers, chunk termination and success aggregation, asset verification, evidence corruption and saved-output verification.
They do not replace an actual simulator episode, real VLA positive or native-reference comparison.
