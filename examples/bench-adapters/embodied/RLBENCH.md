# Native RLBench

Orbit runs RLBench's native task, controller and verdict in CoppeliaSim. Xvfb with Mesa GLX
provides software camera rendering on a headless Linux host. The simulator can run without a
GPU, and a Policy service can independently reserve one.
Each episode starts a fresh simulator process. Repeated CoppeliaSim launches in one Python process
can change rendered RGB for the same scene.

| Registration | Tasks | Reset and control |
| --- | ---: | --- |
| `rlbench-mt100-native` | 100 | Native MT100 tasks with seeded variations, two RGB cameras and joint velocity plus discrete gripper. Orbit uses a 200-command cap for this seeded recipe. |
| `rlbench-rvt18-native` | 18 | RVT test tasks, with 25 published test initial states per task. Four RGB views with world-frame point clouds, the clipped gripper state and time feature, and the RVT planner with its collision flag. The cap is 25 policy commands. |

MT100 uses the pinned official task split. The 18-task score is a separate evaluation
condition. RVT reset restores the recorded random state and variation. Orbit hashes the two
native reset files for each episode and renders policy observations live. A rejected RVT pose
plan ends the episode with score zero, and the saved native result includes the exception class.
[RLBench](https://github.com/stepjam/RLBench) · [RVT reference](https://github.com/NVlabs/RVT#evaluate-on-rlbench)

## Build and register MT100

Use clean checkouts of [RLBench](https://github.com/stepjam/RLBench/tree/02720bba4c73fe02eb75df946b8791b806028a9d)
and [PyRep](https://github.com/stepjam/PyRep/tree/8f420be8064b1970aae18a9cfbc978dfb15747ef).
Set `$COPPELIASIM_ARCHIVE` to the CoppeliaSim Edu 4.1.0 archive for Ubuntu 20.04. The
build command verifies its checksum before extracting it and exports the pinned source commits.
The configurator checks the selected protocol's build manifest and entrypoint before freezing
the image ID. The archive SHA-256 is
`512de3a7347387fcc1b12fa675195a912265753f7901808382865bbf51a2a7f8`.
Build locally under the upstream licenses.
[CoppeliaSim archive](https://downloads.coppeliarobotics.com/V4_1_0/CoppeliaSim_Edu_V4_1_0_Ubuntu20_04.tar.xz) ·
[CoppeliaSim licensing](https://manual.coppeliarobotics.com/en/licensing.htm) ·
[RLBench license](https://github.com/stepjam/RLBench/blob/02720bba4c73fe02eb75df946b8791b806028a9d/LICENSE)

```bash
python3 -B examples/bench-adapters/embodied/native_runtime.py rlbench \
  --source "$RLBENCH_SOURCE" --pyrep-source "$PYREP_SOURCE" \
  --coppeliasim-archive "$COPPELIASIM_ARCHIVE" --tag orbit/rlbench:mt100

python3 -B examples/bench-adapters/embodied/configure_rlbench.py \
  --source "$RLBENCH_SOURCE" --pyrep-source "$PYREP_SOURCE" \
  --benchmark-image orbit/rlbench:mt100 --output-dir "$RLBENCH_CONFIG"
orbit bench add-file "$RLBENCH_CONFIG/benchmark.json"
```

## Build and register the RVT test suite

Use [RVT](https://github.com/NVlabs/RVT/tree/367995a1a2169b6352bf4e8b0ed405890462a3a0) at
`367995a1a2169b6352bf4e8b0ed405890462a3a0` and initialize its `rvt/libs/RLBench` and
`rvt/libs/PyRep` submodules. The RVT simulator uses those pinned revisions.

Extract the published PerAct **test** demos into `$RLBENCH_TEST`. Each
`<task>/all_variations/episodes/episode0` through `episode24` needs `low_dim_obs.pkl`
and `variation_number.pkl`. The runtime uses RLBench's original pickled demo objects.
Use trusted test data from the authors or a verified mirror.
[PerAct test dataset instructions](https://github.com/peract/peract#download-datasets) ·
[Test dataset mirror](https://huggingface.co/datasets/hqfang/rlbench-18-tasks/tree/70e649d710f0c491119b51b83aca252b6f356bde/data/test)

```bash
python3 -B examples/bench-adapters/embodied/native_runtime.py rlbench \
  --source "$RVT_SOURCE/rvt/libs/RLBench" --pyrep-source "$RVT_SOURCE/rvt/libs/PyRep" \
  --rvt-source "$RVT_SOURCE" --coppeliasim-archive "$COPPELIASIM_ARCHIVE" --tag orbit/rlbench:rvt18

python3 -B examples/bench-adapters/embodied/configure_rlbench.py \
  --source "$RVT_SOURCE/rvt/libs/RLBench" --pyrep-source "$RVT_SOURCE/rvt/libs/PyRep" \
  --rvt-source "$RVT_SOURCE" --test-data "$RLBENCH_TEST" \
  --benchmark-image orbit/rlbench:rvt18 --output-dir "$RVT_CONFIG"
orbit data add rlbench-rvt-test "$RLBENCH_TEST"
orbit bench add-file "$RVT_CONFIG/benchmark.json"

python3 -B examples/bench-adapters/embodied/plan.py --reference-source "$RVT_SOURCE" \
  --reference-file "$RVT_CONFIG/reference.json" \
  --all-tasks --all-initial-states > "$RVT_CONFIG/samples.json"
```

Use explicit `--initial-state` indices to plan MT100. For either registration, a separate
`policy-ws` service can implement the exact observation and action profile in `reference.json`.
Run its frozen samples with `orbit bench run` and the registered Policy.
[Policy registration template](../../../docs/guides/embodied-onboarding.md)
