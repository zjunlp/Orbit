# Native LIBERO-Mem

The `libero-mem-native` registration covers ten ordered manipulation tasks and 20 published
initial states per task. The native BDDL runtime handles ordered goals and alternative valid
branches. Orbit advances the native subgoal timers on every warm-up and control step, uses 10
warm-up controls, and sets the control horizon to the greater of 300 steps or 250 steps per subgoal.
An episode ends when the entire goal sequence is satisfied or the horizon is reached. Reports
include the mean per-episode fraction of completed subgoals and the full-sequence success rate.
[Benchmark](https://github.com/libero-mem/libero-mem/tree/0eee0defa4024e51511b6e15a79f30e9620209de) ·
[VoLoAgent runner and timing parameters](https://github.com/NVlabs/VoLoAgent/blob/b4e623079ca8498a16bcd5016920d71f76c44d30/examples/libero/run_mem_eval.py)

## Build and register

Set `LIBERO_MEM_SOURCE` to the pinned LIBERO-Mem checkout and place the ten `.pruned_init`
files in `LIBERO_MEM_STATES`. Use the [RLinf reproduction files](https://github.com/anHappyDog/RLinf/tree/8d0f7cffcd5d315182faa104adb31b9ca52de9e4/evaluations/libero/init_states/libero_mem)
with the names in the native suite. These files provide a consistent 20-state catalog for all ten
tasks. The separate demonstration-generation examples in the benchmark source supply assets for
four tasks. The build checks all ten reproduction hashes. Set `LIBERO_MEM_BASE` to
the MuJoCo 3.3.2 [Fast-WAM LIBERO simulator base](../../policies/fast-wam/README.md).

```bash
config=examples/bench-adapters/embodied/benchmarks/libero-mem/configure_libero_mem.py
python -B "$config" --source "$LIBERO_MEM_SOURCE" --base-image "$LIBERO_MEM_BASE" \
  --initial-states "$LIBERO_MEM_STATES" --build-tag orbit/libero-mem:reference
python -B "$config" --source "$LIBERO_MEM_SOURCE" --base-image "$LIBERO_MEM_BASE" \
  --benchmark-image orbit/libero-mem:reference --output-dir "$LIBERO_MEM_CONFIG"

registration="$LIBERO_MEM_CONFIG/libero-mem-native"
orbit bench add-file "$registration/benchmark.json"
python -B examples/bench-adapters/embodied/plan.py --reference-source "$LIBERO_MEM_SOURCE" \
  --reference-file "$registration/reference.json" --all-tasks --all-initial-states > "$registration/samples.json"
```

An independently registered policy must accept the native LIBERO observation and action semantics
and advertise an eight-action replan interval. To use the existing [OpenPI π₀.₅ LIBERO recipe](../libero/README.md),
give its policy JSON a new `name`, set `replanSteps` to 8, and keep the existing checkpoint and
normalization identifiers. Use that registration in `orbit bench run libero-mem-native`.

The native verifier checks each progress prefix against the frozen BDDL branches using the original
object IDs. It also checks the numerator, denominator and stopping rule. To revalidate episodes
from the first evidence format, regenerate the registration and sample plan, then rerun the episodes
with the updated driver so the trace contains the original predicates. A newly completed subgoal alone leaves the
episode running. This stopping rule covers the whole sequence even when the reference client
promotes a single native subgoal transition to a terminal signal.
