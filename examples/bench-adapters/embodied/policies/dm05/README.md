# DM0.5 on native VLA-Arena

Use the [Arena fine-tuned checkpoint](https://huggingface.co/Dexmal/DM05-Vla-Arena/tree/12e0ec028dca289cd53aa14bd487ff12b8cc0977)
and a clean [OpenDM checkout](https://github.com/dexmal/opendm/tree/03f799120d425ead51d9482bb1da950b6dabade9).
Place the checkpoint, processor files and `norm_stats.json` in `DM05_WEIGHTS` outside the checkout.
The policy loads the local files with Hub access disabled.

Build the [VLA-Arena simulator](../../benchmarks/vla-arena/README.md) first. Set `VLA_ARENA_SOURCE`
to its pinned source checkout and `LOCAL_CONFIG` to an external output directory.

```bash
policy=examples/bench-adapters/embodied/policies/dm05/configure_dm05.py
arena=examples/bench-adapters/embodied/benchmarks/vla-arena/configure_vla_arena.py
python3 -B "$policy" --source "$OPENDM_SOURCE" --build-tag orbit/dm05-vla-arena:reference \
  --policy-base pytorch/pytorch:2.11.0-cuda12.8-cudnn9-devel
python3 -B "$arena" --source "$VLA_ARENA_SOURCE" --benchmark-image orbit/vla-arena:reference \
  --recipe dm05 --environment-seed 7 --output-dir "$LOCAL_CONFIG"
benchmark=vla-arena-safety-static-obstacles-dm05-seed7-native
recipe="$LOCAL_CONFIG/$benchmark"
python3 -B "$policy" --source "$OPENDM_SOURCE" --weights "$DM05_WEIGHTS" \
  --policy-image orbit/dm05-vla-arena:reference --reference-file "$recipe/reference.json" \
  --output "$LOCAL_CONFIG/dm05-policy.json"
orbit data add dm05-vla-arena "$DM05_WEIGHTS"
orbit policy add "$LOCAL_CONFIG/dm05-policy.json"
orbit bench add-file "$recipe/benchmark.json"
python3 -B examples/bench-adapters/embodied/plan.py --reference-source "$VLA_ARENA_SOURCE" \
  --reference-file "$recipe/reference.json" --all-tasks --initial-state 0 \
  > "$recipe/samples.json"
orbit bench run "$benchmark" --method model=policy,policyRef=dm05-vla-arena \
  --sample-plan "$recipe/samples.json"
```

The [OpenDM evaluator](https://github.com/dexmal/opendm/blob/03f799120d425ead51d9482bb1da950b6dabade9/third_party/vla_arena/eval_config.yaml)
uses unrotated agent and wrist images and an eight-element Panda state. The policy generates
20 controls. The driver executes ten before replanning. Translation and gripper values are
thresholded at ±0.5 before control. The policy uses the OpenDM BF16 inference path with SDPA
for vision and a Torch stream seeded at service startup.

The recipe selects the first published initial state per task and derives the environment seed
as `base seed + task index × 10000 + repetition`. The official base seeds are 7, 42 and 1000.
Use `--repetitions 10` for the official count per task and seed. The default Arena simulator uses
CPU OSMesa, with one GPU for the Policy. Reports retain native task success and raw constraint
cost separately. The DM0.5 recipe uses the upstream ungated success rule and unscaled cost.
