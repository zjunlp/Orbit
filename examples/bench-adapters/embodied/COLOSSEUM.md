# Colosseum V2

Orbit registers the pinned [Colosseum V2 release source](https://github.com/jstmn/ColosseumV2/tree/d16081b3ff6ea4516821f4ad5f66daccaf51c4ed). The native ACT sweep defines 16 single-arm and 12 bimanual tasks. The registrations expose each morphology with each of the 21 presets used by the evaluator, including the unperturbed and combined presets. An individual perturbation disabled by its native task appears as unsupported, and the combined preset applies the upstream task-specific exclusions. Each task retains the evaluator's task-specific horizon and perturbed instruction.

The single-arm profile uses normalized Cartesian pose deltas with XYZ Euler rotation and a normalized gripper command. The bimanual profile uses absolute arm joint targets and a normalized gripper command for each arm. Both expose the native RGB cameras in evaluator order, the unnormalized ACT proprioceptive vector and the exact instruction. An ACT implementation can resize and normalize these observations in its Policy service. The benchmark accepts an independently registered Policy with a matching profile and a one-step replan interval. The official ACT recipe uses temporal ensembling, which belongs in the Policy service.

The Solve runs one GPU PhysX environment per episode with an independently frozen reset seed. It runs the complete native evaluator horizon and records both success at any control step, the official score, and success at the end. Orbit batches share a Policy service and process episodes in sample order. The published 100-environment sweep uses vectorized simulation with a different reset stream. [Official evaluator](https://github.com/jstmn/ColosseumV2/blob/d16081b3ff6ea4516821f4ad5f66daccaf51c4ed/examples/baselines/act_clip/eval_rgbd.py)

## Prepare and register

Use the pinned Colosseum V2 source and the ManiSkill 3.0.0b22 simulator base from [native tabletop setup](NATIVE-EXPANSION.md). Set `COLOSSEUM_SOURCE`, `COLOSSEUM_ASSETS` and `COLOSSEUM_CONFIG` to user-owned directories outside the checkout. The build uses the exact fork from the selected checkout and pins the base image in its manifest.

```bash
colosseum_config=examples/bench-adapters/embodied/configure_colosseum.py
colosseum_base=orbit/embodied-maniskill3:3.0.0b22
colosseum_image=orbit/colosseum-v2:reference

python3 -B "$colosseum_config" --source "$COLOSSEUM_SOURCE" \
  --simulator-base "$colosseum_base" --build-tag "$colosseum_image"

python3 -B "$colosseum_config" --source "$COLOSSEUM_SOURCE" \
  --simulator-base "$colosseum_base" --benchmark-image "$colosseum_image" \
  --assets "$COLOSSEUM_ASSETS" --prepare-assets

python3 -B "$colosseum_config" --source "$COLOSSEUM_SOURCE" \
  --simulator-base "$colosseum_base" --benchmark-image "$colosseum_image" \
  --assets "$COLOSSEUM_ASSETS" --output-dir "$COLOSSEUM_CONFIG"
```

The build accepts `--dependency-wheels` to reuse a directory of already downloaded Python wheels. Asset preparation attempts each missing download with the fork's downloader and reports any failures. Preparation alone exits with an error if downloads fail. With `--output-dir`, it can register the resulting asset directory and list cases with missing files as unsupported. The registered dataset is mounted read-only and checked against its content digest. The cabinet tasks use fixed PartNet Mobility models `1005`, `1027` and `45427`, with `45427` bundled in the pinned fork. `PickSodaFromCabinet-v1` uses the open cabinet and shelf XML files and their textures from the fork's [RoboCasa asset distribution](https://huggingface.co/datasets/haosulab/RoboCasa).

```bash
orbit data add colosseum-v2-assets "$COLOSSEUM_ASSETS"
config="$COLOSSEUM_CONFIG/colosseum-v2-single-arm-none-native"
orbit bench add-file "$config/benchmark.json"
orbit bench tasks colosseum-v2-single-arm-none-native --json
python3 -B examples/bench-adapters/embodied/plan.py \
  --reference-source "$COLOSSEUM_SOURCE" --reference-file "$config/reference.json" \
  --task RaiseCube-v1 --environment-seed 0 --initial-state 0 > "$config/samples.json"
orbit bench run colosseum-v2-single-arm-none-native \
  --method "candidate=policy,policyRef=$COLOSSEUM_POLICY" --sample-plan "$config/samples.json"
```

Use the generated reference's `benchmarkProfile` to configure the Policy I/O. The reference ACT weights and setup are published in the [upstream README](https://github.com/jstmn/ColosseumV2/blob/d16081b3ff6ea4516821f4ad5f66daccaf51c4ed/README.md#evaluate-the-multi-task-language-conditioned-act-model-from-the-paper). Match the checkpoint to the morphology, controller, camera order and its action normalization.
