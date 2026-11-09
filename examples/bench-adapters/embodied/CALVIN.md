# Native CALVIN ABC→D with RLinf π₀.₅

One sample is a five-instruction sequence in scene D. The simulator resets once per
sequence and uses the native CALVIN task oracle for each instruction. At a success
boundary the driver requests a new action chunk and keeps the current scene. An
instruction gets up to 480 control steps. The primary metric averages the number of
consecutive completed subtasks on a 0–5 scale. Each prefix length has a separate success rate.

Use the [RLinf reference checkout](https://github.com/RLinf/RLinf/tree/1bf78980d9339cbc67497eddceb9a1e3a74e2acc),
the [CALVIN checkout](https://github.com/mees/calvin/tree/fa03f01f19c65920e18cf37398a9ce859274af76)
with its submodules, and the [PyHash fork](https://github.com/RLinf/pyfasthash/tree/577fab8167020f31349c00d60afea96e7923a023)
with its submodules. The simulator uses the tracked CALVIN assets and RLinf scene configuration.
The catalog exporter uses the pinned RLinf sequence generator and native reset helpers to
freeze all 1,000 sequences and their initial states. Keep sources, assets and generated files
outside the Orbit checkout.

Use the [RLinf checkpoint](https://huggingface.co/RLinf/RLinf-Pi05-CALVIN-ABC-D-SFT/tree/ffe18938a37d3855c9ff50d6220d39bcd6434f15)
and retain its normalization file at `InternRobotics/InternData-Calvin_ABC/norm_stats.json`.
The serving image reuses the [RoboCasa OpenPI base](ROBOCASA365.md).

```bash
adapter=examples/bench-adapters/embodied
docker build --label orbit.task=calvin --build-arg SIMULATOR_BASE=orbit/simpler-native:reference \
  --build-context calvin="$CALVIN_SOURCE" --build-context rlinf="$RLINF_SOURCE" \
  --build-context pyfasthash="$PYHASH_SOURCE" -f "$adapter/calvin.Dockerfile" \
  -t orbit/embodied-calvin:reference .
docker build --label orbit.task=calvin --build-arg POLICY_BASE=orbit/robocasa365-policy:reference \
  -f "$adapter/metaworld-policy.Dockerfile" -t orbit/embodied-calvin-policy:reference .

mkdir -p "$LOCAL_CONFIG"
docker run --rm --network none --cpus 4 --label orbit.task=calvin \
  orbit/embodied-calvin:reference -B /opt/calvin/catalog.py > "$LOCAL_CONFIG/catalog.json"

python3 -B "$adapter/configure_calvin.py" --reference-source "$RLINF_SOURCE" \
  --sequence-catalog "$LOCAL_CONFIG/catalog.json" --weights "$CALVIN_WEIGHTS" \
  --benchmark-image orbit/embodied-calvin:reference --policy-image orbit/embodied-calvin-policy:reference \
  --output-dir "$LOCAL_CONFIG"
orbit data add pi05-rlinf-calvin-abc-d "$CALVIN_WEIGHTS"
orbit policy add "$LOCAL_CONFIG/policy.json"
orbit bench add-file "$LOCAL_CONFIG/benchmark.json"

python3 -B "$adapter/plan.py" --reference-source "$RLINF_SOURCE" \
  --reference-file "$LOCAL_CONFIG/reference.json" --task calvin-abc-d \
  --initial-state 0 --initial-state 1 > "$LOCAL_CONFIG/samples.json"
orbit bench calibrate calvin-abc-d-native --policy pi05-rlinf-calvin-abc-d \
  --sample-plan "$LOCAL_CONFIG/samples.json" --budget 20 --json
```

The initial-state index selects a complete sequence from the frozen catalog.
`--all-initial-states` expands the catalog for a regular evaluation. Verification and rescore
check the recorded sequence, instruction boundaries, completion count and per-instruction
control limit on CPU. The simulator and policy use the shared GPU reservation.
