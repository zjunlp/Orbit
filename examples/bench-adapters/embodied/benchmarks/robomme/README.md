# RoboMME

Orbit registers the complete public `test` split from the
[pinned RoboMME revision](https://github.com/RoboMME/robomme_benchmark/tree/777c595d9c443405fdc145452929bc5890c13e19).
Counting, Permanence, Reference and Imitation each contain four tasks with 50 frozen episodes
per task. `initialStateId` selects the upstream episode index. The native metadata supplies its
seed and difficulty. The benchmark uses two native RGB cameras, the first task goal, the Panda
joint state and eight-dimensional joint-angle commands. The official `pi05_baseline` configuration
executes 16 controls per query and caps scored episodes at 1,300 controls. CPU verification
checks the frozen initial state, controller inputs, stop status and score. Orbit records simulator
errors as invalid episodes with native diagnostics. The official success rate counts them as
failures. A simulator error stops the shared Solve batch. Episodes that have yet to start are
reported as missing. Trial review includes the two control videos and saves any
native reset demonstration as separate videos.

The registration covers the joint-angle evaluation protocol. RoboMME-Plus, the other native
action spaces and history-aware policy bindings are outside this recipe. The training HDF5
archive is optional for evaluation because the test metadata and reset logic ship with the source.

## Build and register

Set `ROBOMME_SOURCE` to the pinned checkout above. Set `ROBOMME_MANISKILL` to RoboMME's
[pinned ManiSkill fork](https://github.com/YinpeiDai/ManiSkill/tree/07be6fbc66350ddca200abfb0a11b692f078f7fd).
Use a headless NVIDIA Vulkan-capable simulator node.

```bash
embodied=examples/bench-adapters/embodied
recipe="$embodied/benchmarks/robomme/configure_robomme.py"
python3 -B "$recipe" --source "$ROBOMME_SOURCE" --maniskill-source "$ROBOMME_MANISKILL" \
  --simulator-base pytorch/pytorch:2.9.1-cuda12.8-cudnn9-runtime --build-tag orbit/robomme-simulator:native
python3 -B "$recipe" --source "$ROBOMME_SOURCE" --benchmark-image orbit/robomme-simulator:native \
  --output-dir "$ROBOMME_CONFIG"
registration="$ROBOMME_CONFIG/robomme-test-joint-native"
orbit bench add-file "$registration/benchmark.json"
python3 -B "$embodied/plan.py" --reference-source "$ROBOMME_SOURCE" \
  --reference-file "$registration/reference.json" --all-tasks --all-initial-states \
  > "$registration/samples.json"
```

For an integration run, replace the two `--all-*` flags with `--task StopCube --initial-state 0`.
See the [official baseline recipe](../../policies/robomme-pi05/README.md) for Policy setup.
