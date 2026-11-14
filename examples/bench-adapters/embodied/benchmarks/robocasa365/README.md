# Native RoboCasa365

Orbit exposes the official multitask, lifelong and full task catalog on the PandaOmron mobile manipulator.
It opens the original Gymnasium environment for each sample and uses its controller and success flag.
The published π₀.₅ policy runs as a separate OpenPI WebSocket service. The reference fixes three
RGB cameras, 16 state values and the native 12-element action layout.
[Task list](https://robocasa.ai/docs/build/html/datasets/datasets_overview.html) · [Published policy recipe](https://github.com/robocasa-benchmark/leaderboard/blob/main/submissions_md/pi05_2026-04-02.md)

| Task set | Tasks | OpenPI registration | GR00T N1.5 registration |
| --- | ---: | --- | --- |
| `atomic_seen` | 18 | `robocasa365-atomic-seen-native` | `robocasa365-atomic-seen-gr00t-native` |
| `composite_seen` | 16 | `robocasa365-composite-seen-native` | `robocasa365-composite-seen-gr00t-native` |
| `composite_unseen` | 16 | `robocasa365-composite-unseen-native` | `robocasa365-composite-unseen-gr00t-native` |
| `target50` | 50 | `robocasa365-target50-native` | `robocasa365-target50-gr00t-native` |

Pass `--task-set` to select the upstream task group. The default is `atomic_seen`. `target50`
combines the three disjoint groups into one registration and reports a mean over tasks. Use the
separate registrations for per-group results. The `--split` option selects the scene and object
distribution independently of the task group. The default `pretrain` matches the published
multitask setup. `--split target` selects held-out kitchens and objects and adds `-target` before
`-native` in the registration name. Each registration freezes the task IDs, per-task horizons,
scene split and asset digest in the sample-plan reference.

The [Xiaomi-Robotics-1](../../policies/xiaomi-robotics-1/README.md) and
[GigaWorld-Policy-0.1](../../policies/gigaworld-policy-01/README.md) setup guides cover their
separate observation, reset and stopping recipes for the same 50 Multitask task IDs.

`all_tasks`, `all_atomic_tasks` and `all_composite_tasks` use the fixed-version dataset registry
and its native task horizons. The full catalog has 317 entries, including the 50 multitask tasks.
`lifelong_learning_phase1` through `lifelong_learning_phase4` register the four disjoint phases
of 65, 20, 20 and 20 tasks. To evaluate retention after phase 2, 3 or 4, use
`lifelong_through_phase2`, `lifelong_through_phase3` or `lifelong_through_phase4`.
Use `--split pretrain` for the published lifelong setup and register the checkpoint for that
phase independently. [RoboCasa lifelong evaluation](https://robocasa.ai/docs/build/html/benchmarking/lifelong_learning.html)

To plan one initial state per task in a registration, pass `--all-tasks --initial-state 0`
to `plan.py` with that registration's `reference.json`.

## Prepare the runtimes and assets

Keep source checkouts, downloaded archives, the assembled asset tree and generated registrations
outside the Orbit checkout. Set the corresponding shell variables below to those locations. The
[benchmark profile](../../profiles/robocasa365-atomic-seen.json) pins RoboCasa, robosuite and the
upstream evaluation recipe. The [policy profile](../../profiles/robocasa365-openpi.json) pins the
official fork and checkpoint separately. Check out each commit before building. Use the audited LIBERO OpenPI serving
image `orbit/openpi-policy:reference` for the dependency base. The policy image loads source
from the RoboCasa team's fork.

```bash
for target in simulator policy; do
  docker build --label orbit.task=robocasa365 --target "$target" \
    --build-context robocasa="$ROBOCASA_SOURCE" --build-context robosuite="$ROBOSUITE_SOURCE" \
    --build-context openpi="$ROBOCASA_OPENPI" \
    -f examples/bench-adapters/embodied/benchmarks/robocasa365/robocasa365.Dockerfile \
    -t "orbit/robocasa365-${target}:reference" .
done

hf download robocasa/robocasa-assets textures.zip generative_textures.zip fixtures.zip objaverse.zip aigen_objs.zip \
  --repo-type dataset --revision 1b92c3d02ca4354984fec961357db0bff7b32166 --local-dir "$ROBOCASA_ARCHIVES"
hf download nvidia/PhysicalAI-Robotics-Manipulation-Objects-Kitchen-MJCF --repo-type dataset \
  --revision 420a04af939c34873e6839a586b70844baf28aab --local-dir "$ROBOCASA_ARCHIVES" \
  --include 'fixtures_lightwheel/*.zip' --include 'objects_lightwheel/*.zip'
python3 -B examples/bench-adapters/embodied/benchmarks/robocasa365/prepare_robocasa365_assets.py \
  --robocasa-source "$ROBOCASA_SOURCE" --archives "$ROBOCASA_ARCHIVES" --output "$ROBOCASA_ASSETS"

checkpoint=pi05_pretrain_human300/multitask_learning/75000
hf download robocasa/robocasa365_checkpoints \
  --revision c484448aba1a9b60a04c9b0ca117241518ea69f3 --local-dir "$ROBOCASA_MODEL_DOWNLOAD" \
  --include "$checkpoint/params/*" --include "$checkpoint/assets/*" --include "$checkpoint/_CHECKPOINT_METADATA"
ROBOCASA_WEIGHTS="$ROBOCASA_MODEL_DOWNLOAD/$checkpoint"
```

The preparation script combines the repository's tracked scene assets and the two pinned archive
sets. The simulation asset tree and the model weights are mounted as separate read-only named
datasets. RoboCasa writes temporary scaled XML next to sampled objects. Each solve container
creates a writable directory view with links to the read-only asset files. The policy download
selects the inference files and excludes the optimizer state. Serving disables the training
dataset statistics fallback in its in-memory config and uses the normalization shipped with the checkpoint.
[Simulator assets](https://huggingface.co/datasets/robocasa/robocasa-assets) · [Lightwheel assets](https://huggingface.co/datasets/nvidia/PhysicalAI-Robotics-Manipulation-Objects-Kitchen-MJCF) · [Checkpoint](https://huggingface.co/robocasa/robocasa365_checkpoints)

## Register and calibrate

To register only the benchmark, pass `--benchmark-only` with the simulator and its assets.
For example, register all 50 tasks on held-out scenes using the OpenPI evaluation recipe.

```bash
python3 -B examples/bench-adapters/embodied/benchmarks/robocasa365/configure_robocasa365.py \
  --benchmark-only --recipe openpi --task-set target50 --split target \
  --robocasa-source "$ROBOCASA_SOURCE" --robosuite-source "$ROBOSUITE_SOURCE" \
  --assets "$ROBOCASA_ASSETS" --benchmark-image orbit/robocasa365-simulator:reference \
  --output-dir "$ROBOCASA_TARGET_CONFIG"
orbit data add robocasa365-assets "$ROBOCASA_ASSETS"
orbit bench add-file "$ROBOCASA_TARGET_CONFIG/benchmark.json"
orbit bench tasks robocasa365-target50-target-native --json
```

For the GR00T benchmark recipe, select `--recipe gr00t`, the pinned RoboCasa 1.0.1 source and
the `simulator-gr00t` image described below. An independently registered compatible policy can
be used with the generated benchmark. The paired example below selects the default Atomic-Seen
task set and `pretrain` scenes.

```bash
python3 -B examples/bench-adapters/embodied/benchmarks/robocasa365/configure_robocasa365.py \
  --robocasa-source "$ROBOCASA_SOURCE" --robosuite-source "$ROBOSUITE_SOURCE" \
  --openpi-source "$ROBOCASA_OPENPI" --assets "$ROBOCASA_ASSETS" --weights "$ROBOCASA_WEIGHTS" \
  --benchmark-image orbit/robocasa365-simulator:reference --policy-image orbit/robocasa365-policy:reference \
  --share-gpu --output-dir "$ROBOCASA_CONFIG"
orbit data add robocasa365-assets "$ROBOCASA_ASSETS"
orbit data add pi05-robocasa365 "$ROBOCASA_WEIGHTS"
orbit bench add-file "$ROBOCASA_CONFIG/benchmark.json"
orbit policy add "$ROBOCASA_CONFIG/policy.json"
orbit bench tasks robocasa365-atomic-seen-native --json

python3 -B examples/bench-adapters/embodied/plan.py --reference-source "$ROBOCASA_SOURCE" \
  --reference-file "$ROBOCASA_CONFIG/reference.json" \
  --task robocasa/OpenStandMixerHead --task robocasa/OpenDrawer \
  --initial-state 0 --environment-seed 7 > "$ROBOCASA_CONFIG/samples.json"
orbit bench calibrate robocasa365-atomic-seen-native --policy pi05-robocasa365-shared \
  --sample-plan "$ROBOCASA_CONFIG/samples.json" --budget 20 --json
```

Use the generated reference when creating plans, since it includes the assembled simulation
asset digest. Registration freezes the source, image, implementation and asset identities. The
shared GPU recipe renders with EGL on the same leased card as the policy and declares 4 GB for
simulation plus 24 GB for the model. Omit `--share-gpu` to lease separate GPUs for the EGL simulator
and the `pi05-robocasa365` policy. Renderer and resource placement are
part of the recorded run conditions.

## Evaluation conditions

- Each sample recreates the `pretrain` Gymnasium environment and takes its first rollout at
  `environmentSeed + initialStateId`. The official runner resets a continuing environment stream
  for subsequent rollouts. The two sampling procedures represent different evaluation conditions.
- RoboCasa's wrapper sets the native camera orientation. OpenPI pads and resizes to 224 pixels,
  sends the three cameras and the concatenated state, and executes the first five actions from
  each inference. A sample stops at native success or at the task's
  `ceil(1.5 * get_task_horizon(task))` control steps.
- Fixed sequential batches advance the model service's JAX stream in plan order. Verification
  and rescore read saved per-episode evidence on CPU. The upstream-style view averages per-task
  success rates and counts invalid episodes as failures. Orbit also reports its valid-only view.
  [Batch execution](../../../../../docs/guides/embodied-batches.md) · [Integration checks](../../../../../docs/guides/policy-integration-checks.md)

The original Atomic-Seen calibration included native resets and controls for all 18 tasks, direct
comparisons on two tasks, and a two-episode real policy batch with independent verification and
rescore. [Atomic-Seen validation](../../../../../docs/tasks/20261107-robocasa365.md) ·
[Multitask validation](../../../../../docs/tasks/20261108-robocasa365-task-sets.md)

## GR00T N1.5

The RoboCasa team's GR00T N1.5 multitask recipe uses RoboCasa 1.0.1 and `pretrain` scenes.
The 1.0.1 registry already includes the increased evaluation horizons. This recipe uses those
horizons directly and executes 16 actions
per prediction. The episode verdict is true if native success is reported at any chunk end,
including the final partial chunk. Orbit saves every native control step and applies the
chunk-end rule again during evidence verification. The frozen samples use an independent scene
seed per episode. The reference runner advances multiple Gymnasium environments across episodes.
The upstream scorer averages per-task rates with available results. Orbit
excludes invalid episodes from that view. [Official submission](https://github.com/robocasa-benchmark/leaderboard/blob/main/submissions_md/gr00t_n1.5_2026_05_19.md)

Use `ROBOCASA101_SOURCE` and `GROOT_N15_SOURCE` at the commits listed in the
[GR00T N1.5 profile](../../profiles/robocasa365-gr00t-n15.json). The runtime uses the published
policy loader and PandaOmron transforms with four denoising steps. It serves over Orbit's
GR00T ZeroMQ transport, sending numeric arrays through MessagePack. The weights dataset
contains both safetensors shards, their index, `config.json` and `experiment_cfg/metadata.json`.
The Eagle configuration and tokenizer are bundled in the pinned fork.

Place the FlashAttention 2.7.4.post1 Linux x86-64 wheel for Python 3.11, Torch 2.7, CUDA 12
and C++11 ABI TRUE in `FLASH_WHEELS`. The Dockerfile verifies its published SHA-256.
The default policy base supplies Torch 2.7.1 with CUDA 12.6.
[FlashAttention release](https://github.com/Dao-AILab/flash-attention/releases/tag/v2.7.4.post1) · [Checkpoint](https://huggingface.co/robocasa/robocasa365_checkpoints/tree/c484448aba1a9b60a04c9b0ca117241518ea69f3/gr00t_n1-5/multitask_learning/checkpoint-120000)

```bash
docker build --label orbit.task=robocasa365-n15 --target simulator-gr00t \
  --build-context robocasa="$ROBOCASA101_SOURCE" --build-context robosuite="$ROBOSUITE_SOURCE" \
  --build-context openpi="$ROBOCASA_OPENPI" -f examples/bench-adapters/embodied/benchmarks/robocasa365/robocasa365.Dockerfile \
  -t orbit/robocasa365-n15-simulator:reference .
docker build --label orbit.task=robocasa365-n15 --target policy \
  --build-context groot="$GROOT_N15_SOURCE" --build-context flash="$FLASH_WHEELS" \
  -f examples/bench-adapters/embodied/policies/groot/groot-n15-policy.Dockerfile \
  -t orbit/robocasa365-n15-policy:reference .

checkpoint=gr00t_n1-5/multitask_learning/checkpoint-120000
hf download robocasa/robocasa365_checkpoints \
  "$checkpoint/config.json" "$checkpoint/experiment_cfg/metadata.json" \
  "$checkpoint/model.safetensors.index.json" "$checkpoint/model-00001-of-00002.safetensors" \
  "$checkpoint/model-00002-of-00002.safetensors" \
  --revision c484448aba1a9b60a04c9b0ca117241518ea69f3 --local-dir "$ROBOCASA_MODEL_DOWNLOAD"
GROOT_N15_WEIGHTS="$ROBOCASA_MODEL_DOWNLOAD/$checkpoint"
python3 -B examples/bench-adapters/embodied/benchmarks/robocasa365/configure_robocasa365.py \
  --robocasa-source "$ROBOCASA101_SOURCE" --robosuite-source "$ROBOSUITE_SOURCE" \
  --groot-source "$GROOT_N15_SOURCE" --assets "$ROBOCASA_ASSETS" --weights "$GROOT_N15_WEIGHTS" \
  --benchmark-image orbit/robocasa365-n15-simulator:reference --policy-image orbit/robocasa365-n15-policy:reference \
  --share-gpu --output-dir "$GROOT_N15_CONFIG"
orbit data add robocasa365-assets "$ROBOCASA_ASSETS"
orbit data add groot-n15-robocasa365 "$GROOT_N15_WEIGHTS"
orbit bench add-file "$GROOT_N15_CONFIG/benchmark.json"
orbit policy add "$GROOT_N15_CONFIG/policy.json"

python3 -B examples/bench-adapters/embodied/plan.py --reference-source "$ROBOCASA101_SOURCE" \
  --reference-file "$GROOT_N15_CONFIG/reference.json" --task robocasa/OpenDrawer \
  --task robocasa/TurnOnMicrowave --initial-state 0 --environment-seed 7 > "$GROOT_N15_CONFIG/samples.json"
orbit bench calibrate robocasa365-atomic-seen-gr00t-native --policy groot-n15-robocasa365-shared \
  --sample-plan "$GROOT_N15_CONFIG/samples.json" --budget 20 --json
```

## Diffusion Policy

Use the RoboCasa 1.0.0 and robosuite sources from the OpenPI simulator recipe, with the Diffusion
Policy and robomimic revisions pinned in the [Diffusion Policy profile](../../profiles/robocasa365-diffusion-policy.json).
The published epoch-0500 checkpoint supplies the EMA model and its normalization. The policy
uses the latest two observations, including all three cameras and the end-effector and gripper
state. It duplicates the reset observation for the first call and encodes the reset instruction
with the pinned CLIP text encoder. Each prediction yields eight native PandaOmron actions.
[Official submission](https://github.com/robocasa-benchmark/leaderboard/blob/main/submissions_md/dp_2026_04_02.md)

The recipe caps each rollout at `int(1.5 * get_task_horizon(task))` and scores it successful if
any executed step earns the native sparse reward. Orbit uses the single-environment stopping
rule of the reference runner, which checks the earlier of the last two success signals after
each action chunk. Orbit freezes an independent first reset per sample. The upstream runner
also supports parallel environments, with a joint stop check and continuing reset streams.

```bash
docker build --label orbit.task=robocasa365-diffusion-policy --target simulator \
  -f examples/bench-adapters/embodied/policies/diffusion-policy/diffusion-policy.Dockerfile \
  -t orbit/robocasa365-diffusion-simulator:reference .
docker build --label orbit.task=robocasa365-diffusion-policy --target policy \
  --build-context diffusion="$DIFFUSION_SOURCE" --build-context robomimic="$ROBOMIMIC_SOURCE" \
  -f examples/bench-adapters/embodied/policies/diffusion-policy/diffusion-policy.Dockerfile \
  -t orbit/robocasa365-diffusion-policy:reference .

checkpoint=diffusion_policy/17.40.09_train_diffusion_transformer_hybrid_pretrain_human300/checkpoints
revision=c484448aba1a9b60a04c9b0ca117241518ea69f3
clip=https://huggingface.co/openai/clip-vit-large-patch14/resolve/32bd64288804d66eefd0ccbe215aa642df71cc41
mkdir -p "$DIFFUSION_WEIGHTS/clip"
curl -fL "https://huggingface.co/robocasa/robocasa365_checkpoints/resolve/$revision/$checkpoint/epoch%3D0500-test_mean_score%3D-1.000.ckpt" \
  -o "$DIFFUSION_WEIGHTS/epoch-0500.ckpt"
for file in config.json merges.txt model.safetensors special_tokens_map.json tokenizer.json tokenizer_config.json vocab.json; do
  curl -fL "$clip/$file" -o "$DIFFUSION_WEIGHTS/clip/$file" || exit 1
done

python3 -B examples/bench-adapters/embodied/benchmarks/robocasa365/configure_robocasa365.py \
  --robocasa-source "$ROBOCASA_SOURCE" --robosuite-source "$ROBOSUITE_SOURCE" \
  --diffusion-source "$DIFFUSION_SOURCE" --robomimic-source "$ROBOMIMIC_SOURCE" \
  --assets "$ROBOCASA_ASSETS" --weights "$DIFFUSION_WEIGHTS" \
  --benchmark-image orbit/robocasa365-diffusion-simulator:reference \
  --policy-image orbit/robocasa365-diffusion-policy:reference \
  --share-gpu --output-dir "$DIFFUSION_CONFIG"
orbit data add robocasa365-assets "$ROBOCASA_ASSETS"
orbit data add diffusion-policy-robocasa365 "$DIFFUSION_WEIGHTS"
orbit bench add-file "$DIFFUSION_CONFIG/benchmark.json"
orbit policy add "$DIFFUSION_CONFIG/policy.json"

python3 -B examples/bench-adapters/embodied/plan.py --reference-source "$ROBOCASA_SOURCE" \
  --reference-file "$DIFFUSION_CONFIG/reference.json" --task robocasa/OpenDrawer \
  --task robocasa/TurnOnMicrowave --initial-state 0 --environment-seed 1111111 \
  > "$DIFFUSION_CONFIG/samples.json"
orbit bench calibrate robocasa365-atomic-seen-diffusion-policy-native \
  --policy diffusion-policy-robocasa365-shared --sample-plan "$DIFFUSION_CONFIG/samples.json" --budget 15 --json
```

The Dockerfile defaults to the existing 1.0.0 simulator and OpenPI dependency images from
the setup above. The new policy image runs Torch inference and serves native actions over
`policy-ws`. The checkpoint, its embedded normalization and the complete local CLIP files
are checked at service startup. Use `--benchmark-only --recipe diffusion-policy` to generate
the benchmark registration independently of the weights.
