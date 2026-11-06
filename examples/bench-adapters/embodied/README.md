# Native LIBERO and independent OpenPI policies

Experimental D1 implementation. Development checks include real π₀.₅ checkpoint positives on
CPU and GPU, native-environment negatives and saved-output rescore/cleanup. Parity with the
upstream evaluation remains unverified. See the task record for validation details.
The existing vla-eval registrations remain separate.

The benchmark adapter lists official LIBERO tasks and runs one frozen sample per solve Run.
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

D1 starts a fresh policy service for every trial. The stock OpenPI protocol cannot reset its
JAX random stream: independently running a later episode does not prove equivalence to the
upstream multi-episode stream. Shared solve batches belong to D2a, additional endpoints and
automatic direct mappings to D2b. The generated simulator configuration uses CPU OSMesa;
renderer changes are explicit conditions and need their own reference checks.

Saved evidence includes requested action chunks, executed controls with source observation and
chunk indexes, native verdict, required state, timing, the contract and resolved binding. Optional
compressed video is separate from scoring evidence; raw camera tensors are not retained by
default. A score of zero from reaching the horizon is valid, while model/environment failures
retain their closed Orbit failure kind and the upstream error-inclusive denominator.

## SDK checks

Use separate Python 3.8 and 3.11 environments with NumPy and the audited `openpi-client` package.
The connector additionally needs Pillow, MsgPack and `websockets` (13.1 supports both versions).

```bash
python -B -m unittest discover -s examples/sdk -p 'test_*.py' -v
```

These checks include a real binary WebSocket round trip with an explicitly synthetic policy
server, chunk truncation at native termination, evidence corruption and saved-output verification.
They do not replace an actual simulator episode, real VLA positive or native-reference comparison.
