# Native RoboCasa365 Atomic-Seen

RoboCasa365 v1.0 provides 18 Atomic-Seen tasks on the PandaOmron mobile manipulator. Orbit opens
the original Gymnasium environment for each sample and uses its controller and success flag.
The published π₀.₅ policy runs as a separate OpenPI WebSocket service. The reference fixes three
RGB cameras, 16 state values and the native 12-element action layout.
[Task list](https://robocasa.ai/docs/build/html/datasets/datasets_overview.html) · [Published policy recipe](https://github.com/robocasa-benchmark/leaderboard/blob/main/submissions_md/pi05_2026-04-02.md)

## Prepare the runtimes and assets

Keep source checkouts, downloaded archives, the assembled asset tree and generated registrations
outside the Orbit checkout. Set the corresponding shell variables below to those locations. The
[benchmark profile](profiles/robocasa365-atomic-seen.json) pins RoboCasa, robosuite and the
upstream evaluation recipe. The [policy profile](profiles/robocasa365-openpi.json) pins the
official fork and checkpoint separately. Check out each commit before building. Use the audited LIBERO OpenPI serving
image `orbit/openpi-policy:reference` for the dependency base. The policy image loads source
from the RoboCasa team's fork.

```bash
for target in simulator policy; do
  docker build --label orbit.task=robocasa365 --target "$target" \
    --build-context robocasa="$ROBOCASA_SOURCE" --build-context robosuite="$ROBOSUITE_SOURCE" \
    --build-context openpi="$ROBOCASA_OPENPI" \
    -f examples/bench-adapters/embodied/robocasa365.Dockerfile \
    -t "orbit/robocasa365-${target}:reference" .
done

hf download robocasa/robocasa-assets textures.zip generative_textures.zip fixtures.zip objaverse.zip aigen_objs.zip \
  --repo-type dataset --revision 1b92c3d02ca4354984fec961357db0bff7b32166 --local-dir "$ROBOCASA_ARCHIVES"
hf download nvidia/PhysicalAI-Robotics-Manipulation-Objects-Kitchen-MJCF --repo-type dataset \
  --revision 420a04af939c34873e6839a586b70844baf28aab --local-dir "$ROBOCASA_ARCHIVES" \
  --include 'fixtures_lightwheel/*.zip' --include 'objects_lightwheel/*.zip'
python3 -B examples/bench-adapters/embodied/prepare_robocasa365_assets.py \
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

```bash
python3 -B examples/bench-adapters/embodied/configure_robocasa365.py \
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
  [Batch execution](../../../docs/guides/embodied-batches.md) · [Integration checks](../../../docs/guides/policy-integration-checks.md)

The development checks cover all 18 native resets and control steps, direct comparisons on two
tasks, and a two-episode real policy batch with independent verification and rescore.
[Validation record](../../../docs/tasks/20261107-robocasa365.md)
