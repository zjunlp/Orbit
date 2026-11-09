# SmolVLA, MolmoAct2, ManiSkill3 and Meta-World

These recipes use separate simulator and policy images. The simulator owns task resets, native control and success.
`policy-ws` sends the observations selected by Binding to a model service and receives native action chunks.
The four recipes reuse the existing fixed-batch, CPU verification and rescore paths.

| Benchmark registration | Policy registration | Published checkpoint | Revision |
| --- | --- | --- | --- |
| `libero-smolvla-native` | `smolvla-libero` | [lerobot/smolvla_libero](https://huggingface.co/lerobot/smolvla_libero) | `a24f1f380461b665158d52acd140152c79e8b36d` |
| `libero-goal-molmoact2-native` | `molmoact2-libero` | [allenai/MolmoAct2-LIBERO](https://huggingface.co/allenai/MolmoAct2-LIBERO) | `0d24a92bd1faf321ef497c3bbd5681af97c65aa2` |
| `maniskill3-plate25-native` | `openvla-oft-rlinf-maniskill3` | [RLinf/RLinf-OpenVLAOFT-GRPO-ManiSkill3-25ood](https://huggingface.co/RLinf/RLinf-OpenVLAOFT-GRPO-ManiSkill3-25ood) | `cf4b6c5a1181c1055c6ab4500d1173b6db9e5ffa` |
| `metaworld-mt50-native` | `pi05-rlinf-metaworld` | [RLinf/RLinf-Pi05-MetaWorld-SFT](https://huggingface.co/RLinf/RLinf-Pi05-MetaWorld-SFT) | `60b2d0309af8bb087c9e9b250f8c7f9db50c0f8e` |

## ManiSkill3 native tabletop tasks

The `3.0.0b22` [tabletop catalog](profiles/maniskill3-tabletop.json) groups tasks by the
native robot, joint controller and observation contract. The adapter freezes each native time limit
and reads `info.success`. Each profile uses 128 × 128 RGB, seeded CPU physics, and the
native normalized `pd_joint_delta_pos` controller. Dual Panda actions use the simulator's
flattened Dict order. The language field is a fixed task description from the catalog.

The `panda-pick-cube`, `dual-panda-pick-cube`, `so100`, `widowxai` and `ycb` profiles
include `goal_pos` as a float32 XYZ target in world metres. The single-arm tasks use the
native RGB observation's goal field. The dual-arm task uses the native goal marker pose.
Register the updated profiles and regenerate sample plans for the `/2` recipe.

Use the ManiSkill3 simulator image below and choose a profile. These registrations accept
an independent `policy-ws` service that matches the profile's observation and action
declarations. The RLinf Plate-25 checkpoint uses a separate WidowX end-effector recipe.

```bash
adapter=examples/bench-adapters/embodied
python3 -B "$adapter/configure_maniskill.py" --profile panda-pick-cube \
  --benchmark-image orbit/embodied-maniskill3:3.0.0b22 --output-dir "$MANISKILL_CONFIG"
orbit bench add-file "$MANISKILL_CONFIG/benchmark.json"
orbit bench tasks maniskill3-tabletop-panda-pick-cube-native --json
python3 -B "$adapter/plan.py" --reference-source "$adapter" \
  --reference-file "$MANISKILL_CONFIG/reference.json" --task PickCube-v1 \
  --initial-state 0 --initial-state 1 > "$MANISKILL_CONFIG/samples.json"
```

The `assembling-kits`, `ycb`, `faucet` and `widowxai` profiles require the corresponding
ManiSkill assets. Download `assembling_kits`, `ycb`, `partnet_mobility_faucet` or `widowxai`
with `python -m mani_skill.utils.download_asset -y` in the pinned runtime and keep the
resulting `data/` tree under `$MANISKILL_ASSETS`. Pass `--assets "$MANISKILL_ASSETS"`
when configuring and register that directory under the dataset name in `reference.json`.
The upstream `PickClutterYCB-v1` has a constant false success flag and is excluded from
scored profiles.

## Build images and prepare weights

Keep checkpoints, source checkouts, simulator assets and generated configs outside the Orbit checkout.
Download the inference files from the checkpoint revisions above into separate directories. Keep only
the final files in each weight directory so the tree digest remains stable. For SmolVLA, place the
configuration, tokenizer and processor files from [SmolVLM2-500M-Video-Instruct](https://huggingface.co/HuggingFaceTB/SmolVLM2-500M-Video-Instruct/tree/7b375e1b73b11138ff12fe22c8f2822d8fe03467)
in the checkpoint's `processor/` directory. The SmolVLA checkpoint contains the model weights used at inference.
MolmoAct2 uses the pinned model code and normalization file shipped in its checkpoint.

Reuse the [native LIBERO image and its OpenPI source checkout](README.md#reference-and-assets) for
SmolVLA and MolmoAct2. Build both model services from the same image.

```bash
adapter=examples/bench-adapters/embodied
docker build --label orbit.task=embodied-eval -f "$adapter/lerobot-policy.Dockerfile" \
  -t orbit/embodied-lerobot-policy:0.5.1 .
```

For ManiSkill3 and Meta-World, check out [RLinf](https://github.com/RLinf/RLinf/tree/1bf78980d9339cbc67497eddceb9a1e3a74e2acc)
at `1bf78980d9339cbc67497eddceb9a1e3a74e2acc`. Build or reuse the
[native Gym simulator image](GR00T.md) and the [OpenVLA-OFT image](OPENVLA.md).
For the Meta-World model image, reuse the [RoboCasa OpenPI policy base](ROBOCASA365.md).
For the ManiSkill3 simulator, prepare the same Torch 2.4.1 CUDA 12.4 wheel bundle as
[RoboTwin](ROBOTWIN.md). Put the [SAPIEN PhysX release archive](https://github.com/sapien-sim/physx-precompiled/releases/tag/105.1-physx-5.3.1.patch0)
in `$MANISKILL_PHYSX/linux-so.zip`. The build checks the archive hash and installs the GPU library for offline execution.

```bash
docker build --label orbit.task=embodied-eval --target maniskill \
  --build-arg SIMULATOR_BASE=orbit/simpler-native:reference \
  --build-context rlinf="$RLINF_SOURCE" --build-context torch_wheels="$ROBOTWIN_TORCH_WHEELS" \
  --build-context physx="$MANISKILL_PHYSX" -f "$adapter/tabletop.Dockerfile" \
  -t orbit/embodied-maniskill3:3.0.0b22 .
docker build --label orbit.task=embodied-eval --target metaworld \
  --build-arg SIMULATOR_BASE=orbit/simpler-native:reference -f "$adapter/tabletop.Dockerfile" \
  -t orbit/embodied-metaworld:3.0.0 .
docker build --label orbit.task=embodied-eval --build-arg POLICY_BASE=orbit/robocasa365-policy:reference \
  -f "$adapter/metaworld-policy.Dockerfile" -t orbit/embodied-metaworld-policy:reference .
```

Assemble the ManiSkill3 dataset with the [RLinf object assets](https://huggingface.co/datasets/RLinf/maniskill_assets/tree/c23fc1880ed7861686d4f995360101eaee4d18a0)
under `rlinf/`, the [Bridge archive](https://huggingface.co/datasets/haosulab/ManiSkill_bridge_v2_real2sim/tree/b5a8f9ba26355ae73758971189e5cdb68f4dad76)
under `data/tasks/bridge_v2_real2sim_dataset/` and the
[WidowX robot assets](https://github.com/haosulab/ManiSkill-WidowX250S/tree/v0.2.0)
under `data/robots/widowx/`. Register the assembled root as `maniskill3-plate-assets`.
Meta-World loads its scenes from the simulator wheel.

## Register and calibrate

Select a recipe with `configure_lerobot.py --model smolvla|molmoact2` or
`configure_tabletop.py --model maniskill3|metaworld`. The generators take a source checkout,
a weight directory, the two image tags and an output directory. ManiSkill3 also takes `--assets`.
Pass `--benchmark-only` to `configure_tabletop.py` to register a simulator without downloading the
example policy. Run each generator with `--help` for its arguments. The resulting registrations pin the
images, content identities, control profile and policy service configuration.

For example, calibrate π₀.₅ on two Meta-World tasks using the published checkpoint.

```bash
python3 -B "$adapter/configure_tabletop.py" --model metaworld \
  --reference-source "$RLINF_SOURCE" --weights "$METAWORLD_WEIGHTS" \
  --benchmark-image orbit/embodied-metaworld:3.0.0 --policy-image orbit/embodied-metaworld-policy:reference \
  --output-dir "$LOCAL_CONFIG"
orbit data add pi05-rlinf-metaworld "$METAWORLD_WEIGHTS"
orbit policy add "$LOCAL_CONFIG/policy.json"
orbit bench add-file "$LOCAL_CONFIG/benchmark.json"
python3 -B "$adapter/plan.py" --reference-source "$RLINF_SOURCE" \
  --reference-file "$LOCAL_CONFIG/reference.json" --task reach-v3 --task push-v3 \
  --initial-state 0 --environment-seed 0 > "$LOCAL_CONFIG/samples.json"
orbit bench calibrate metaworld-mt50-native --policy pi05-rlinf-metaworld \
  --sample-plan "$LOCAL_CONFIG/samples.json" --budget 20 --json
```

Use `orbit bench tasks <registration> --json` to select sample tasks. Pass `--suite libero_goal`
to the plan generator for MolmoAct2. The SmolVLA recipe uses 10 settle steps and replans every
50 steps. MolmoAct2 uses 50 settle steps and replans every 10 steps. The ManiSkill3 recipe selects the
Plate-25 main task and uses an eight-step chunk. Meta-World selects the 50-task catalog and uses
15 zero-action settle steps followed by at most 160 control steps, with five actions per inference.
Meta-World uses the same unsigned 32-bit seed (`environmentSeed + initialStateId`) to construct MT1
goals and reset the environment. Generate sample plans with the seeded `metaworld-rlinf-reference/2`
recipe.
The Meta-World service uses eager Torch to keep the first inference within its deadline.

Each sample stops at native success, native termination or its frozen horizon. Batches advance the
policy service's Torch random stream in order. These sampling and stopping conditions describe the
Orbit recipe. [Validation scope](../../../docs/tasks/20261108-embodied-native-expansion.md)
