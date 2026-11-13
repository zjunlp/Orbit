# Native RoboMimic

Orbit registers Lift, Can, Square, Transport, and Tool Hang from the proficient-human
(PH) release for robosuite 1.5.1. Each task has a low-dimensional and an RGB registration.
Low-dimensional profiles preserve object state and proprioception. RGB profiles use the
published camera layouts and proprioception. Transport has two 7-component arm commands.
The remaining tasks have one. The four standard RGB views on Transport and the side
and wrist views on Tool Hang retain their native camera IDs.

A sample resets the environment with the planned seed and restores the resulting native
state using RoboMimic's rollout procedure. The driver stops at native success, native
termination, or the registry horizon of 400 or 700 commands. The CPU verifier checks
the saved stopping record. Samples use the base seed plus their initial-state index.
[PH datasets and version notes](https://robomimic.github.io/docs/datasets/robomimic_v0.1.html)

## Build and register

Use clean checkouts of [robomimic](https://github.com/ARISE-Initiative/robomimic/tree/d309eaecc18acf4152a830a895a6984b8ac71b05)
and [robosuite 1.5.1](https://github.com/ARISE-Initiative/robosuite/tree/51cc01785bab80ffeed20da15e67d7dd4140e76a).
Download the five `v1.5/<task>/ph/low_dim_v15.hdf5` files from the official dataset
into `$ROBOMIMIC_DATA` as `lift.hdf5`, `can.hdf5`, `square.hdf5`, `transport.hdf5`,
and `tool_hang.hdf5`. The registration environment needs `h5py` to extract and
fingerprint the metadata. The simulator image contains all runtime dependencies.
[Official dataset](https://huggingface.co/datasets/robomimic/robomimic_datasets/tree/main/v1.5)

```bash
python3 -B examples/bench-adapters/embodied/benchmarks/configure_manipulation.py robomimic \
  --source "$ROBOMIMIC_SOURCE" --robosuite-source "$ROBOSUITE_SOURCE" \
  --build-tag orbit/robomimic:reference

python3 -B examples/bench-adapters/embodied/benchmarks/configure_manipulation.py robomimic \
  --source "$ROBOMIMIC_SOURCE" --robosuite-source "$ROBOSUITE_SOURCE" \
  --data "$ROBOMIMIC_DATA" --benchmark-image orbit/robomimic:reference \
  --output-dir "$ROBOMIMIC_CONFIG"

config="$ROBOMIMIC_CONFIG/robomimic-lift-low-dim-native"
orbit bench add-file "$config/benchmark.json"
python3 -B examples/bench-adapters/embodied/plan.py --reference-source "$ROBOMIMIC_SOURCE" \
  --reference-file "$config/reference.json" --all-tasks --initial-state 0 --initial-state 1 \
  > "$config/samples.json"
```

A separate Policy service can implement the generated observation and action profile
using the [Policy registration template](../../../../../docs/guides/embodied-onboarding.md).
The CoRL 2021 model zoo documents a separate legacy runtime using robomimic v0.1 and
robosuite's `offline_study` branch. Use weights trained for the registered runtime,
observation and control conditions. [Model zoo](https://robomimic.github.io/docs/model_zoo/robomimic_v0.1.html)
