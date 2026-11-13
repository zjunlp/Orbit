# Native BiGym 2.0

This adapter covers all 20 official **learned-policy** tasks at the pinned BiGym 2.0 revision.
The upstream registry also contains 20 tasks outside that protocol, and its coding-agent track
has a separate interface and seed policy.

Orbit registers two profiles. The no-pitch profile has 6 tasks with 20 actions and 50
proprioception values. The pitch profile has 14 tasks with 21 actions and 56 proprioception
values. Both expose the three native 84×84 cameras and the task instruction. The simulator
uses the native G1 robot, frozen GR00T-WBC lower-body controller, and 50 Hz upper-level
control. Policy actions use the native normalized layout. A compatible policy is registered
separately against the appropriate profile.

Each task uses its upstream horizon and the 100 seeds 620000–620099. The episode ends at
the native terminal timestep. The score is 1 when the task succeeds and the robot never
falls. CPU verification checks the recorded controls and termination before Orbit scores
or rescores the sample. BiGym's reported leaderboard statistic also aggregates five
training checkpoints, which can be evaluated separately on the same frozen sample plan.

[Official configuration](https://bigym2.github.io/docs/official_configuration.html) ·
[Reference source](https://github.com/swirl-uk/BiGym2/tree/35ec40923421aff26ac2a525adea428567732898)

## Build and register

Run from the Orbit checkout with a host Python 3.11 virtual environment containing NumPy.
Set `BIGYM2_SOURCE` and `BIGYM2_CONFIG` to directories outside the checkout. The simulator
has its own Python 3.12 environment and uses the upstream dependency lockfile.

```bash
git clone https://github.com/swirl-uk/BiGym2 "$BIGYM2_SOURCE"
git -C "$BIGYM2_SOURCE" checkout 35ec40923421aff26ac2a525adea428567732898
configurator=examples/bench-adapters/embodied/benchmarks/bigym2/configure_bigym2.py
python3 -B "$configurator" --source "$BIGYM2_SOURCE" --build-tag orbit/bigym2:reference
python3 -B "$configurator" --source "$BIGYM2_SOURCE" --benchmark-image orbit/bigym2:reference \
  --output-dir "$BIGYM2_CONFIG"

config="$BIGYM2_CONFIG/bigym2-no-pitch-native"
orbit bench add-file "$config/benchmark.json"
python3 -B examples/bench-adapters/embodied/plan.py --reference-source "$BIGYM2_SOURCE" \
  --reference-file "$config/reference.json" --task reach_target_multi_modal --initial-state 0 \
  > "$config/samples.json"
```

Repeat registration for `bigym2-pitch-native`. For a complete plan for either profile,
use `--all-tasks --all-initial-states`. The EGL renderer requests one NVIDIA GPU for
the simulator. To target a particular GPU for a benchmark run, restrict the daemon's
eligible GPUs as described in the [multi-node guide](../../../../../docs/guides/multi-node.md).
