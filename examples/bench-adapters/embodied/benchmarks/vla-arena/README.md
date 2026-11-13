# Native VLA-Arena

Orbit registers the 11 VLA-Arena suites and all 170 tasks across L0–L2, including 75 safety tasks,
30 distractor tasks, 45 extrapolation tasks and 20 long-horizon tasks. Task IDs preserve the native
suite, level and task name. The simulator image contains the benchmark assets and initial states
from the pinned [official checkout](https://github.com/PKU-Alignment/VLA-Arena/tree/babe582ebffc82b979b77964a7e56417d02f63a4).

## Build and register

Set `VLA_ARENA_SOURCE` to a clean checkout at the pinned commit and `LOCAL_CONFIG` to an output
directory. Build the [RoboMimic runtime base](../robomimic/README.md) if it is unavailable. The default base
tag is `orbit/robomimic:reference`; specify `--base-image` at build and registration to select a
different tag for the same compatible runtime.

```bash
python3 examples/bench-adapters/embodied/benchmarks/vla-arena/configure_vla_arena.py --source "$VLA_ARENA_SOURCE" \
  --build-tag orbit/vla-arena:reference
python3 examples/bench-adapters/embodied/benchmarks/vla-arena/configure_vla_arena.py --source "$VLA_ARENA_SOURCE" \
  --benchmark-image orbit/vla-arena:reference --output-dir "$LOCAL_CONFIG"
for suite in "$LOCAL_CONFIG"/vla-arena-*-native; do
  orbit bench add-file "$suite/benchmark.json"
done
```

CPU OSMesa is the default renderer. Use `--renderer egl` to register a GPU simulator when needed.
Use an independently registered Policy with the raw Panda profile and eight-action replanning.
The upstream Arena OFT checkpoint uses FiLM without a proprioception projector and needs a
compatible Policy server. [Official OFT configuration](https://github.com/PKU-Alignment/VLA-Arena/blob/babe582ebffc82b979b77964a7e56417d02f63a4/vla_arena/configs/evaluation/openvla_oft.yaml)
Use [the DM0.5 recipe](../../policies/dm05/README.md) for ten-action replanning and OpenDM scoring.

```bash
benchmark=vla-arena-safety-static-obstacles-native
orbit bench tasks "$benchmark" --json
python3 examples/bench-adapters/embodied/plan.py --reference-source "$VLA_ARENA_SOURCE" \
  --reference-file "$LOCAL_CONFIG/$benchmark/reference.json" --all-tasks --initial-state 0 \
  > "$LOCAL_CONFIG/$benchmark/samples.json"
orbit bench run "$benchmark" --method "model=policy,policyRef=$POLICY" \
  --sample-plan "$LOCAL_CONFIG/$benchmark/samples.json"
```

The plan freezes the released initial-state file, index, and simulator seed 7. Use
`--all-initial-states` to expand every available index, 8,500 across all 11 suites. After ten
native settling actions, each task runs up to 300 controls. Long Horizon L1–L2 run up to 600. Safety suite success requires the
native task verdict and the OFT evaluator's cost threshold. Reports also retain cumulative
safety cost, including the native horizon cost and Hazard Avoidance scaling. Use
`--task-success-only` to select the official evaluator's ungated variant while still reporting
safety cost for those suites. [Native OFT evaluator](https://github.com/PKU-Alignment/VLA-Arena/blob/babe582ebffc82b979b77964a7e56417d02f63a4/vla_arena/models/openvla_oft/evaluator.py)

The method summary in `orbit bench show` reports success by difficulty as `success_l0` through
`success_l2` alongside the overall score. Safety suites also report `safety_cost_l0` through
`safety_cost_l2`. Each level uses the valid trials from its own tasks, so a sample plan that skips
a level leaves its metric empty.

## Language and visual probes

Pass `--visual-level 1` through `--visual-level 4` to add the native cumulative lighting, color,
camera-offset and noise probes. Pass `--language-level 1` through `--language-level 4` along with
`--language-dir` containing the selected `comprehensive_word_replacements_<level>.json` from the
[pinned language dataset](https://huggingface.co/datasets/VLA-Arena/language_replacements/tree/0f3410ac91335a86aaca4141539c6385bfc7f158).
The configurator freezes one released paraphrase per task and initial-state index using the
native replacement draw. Tasks without a matching replacement keep their official instruction.
V0 and W0 are the baseline. Probe registrations have separate names and sample plans.
[Perturbation protocol](https://arxiv.org/html/2512.22539#S2.SS4)
