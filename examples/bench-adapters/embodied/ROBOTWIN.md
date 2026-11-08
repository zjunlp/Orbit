# Native RoboTwin 2.0

The `robotwin-demo-clean-native` registration exposes the upstream `adjust_bottle` task on
Aloha-AgileX. RoboTwin owns scene setup, expert feasibility, joint control and `eval_success`.
The independently registered `pi05-robotwin-adjust-bottle` policy serves the published community
single-task OpenPI-PACE checkpoint over the existing OpenPI WebSocket connector.
[Benchmark](https://github.com/RoboTwin-Platform/RoboTwin) · [Checkpoint](https://huggingface.co/niejunnan25/pi05-robotwin)

## Prepare the runtimes and assets

Keep checkouts, archives, weights and generated configurations outside the Orbit checkout.
Check out RoboTwin, cuRobo and OpenPI-PACE at the commits in the [benchmark profile](profiles/robotwin-demo-clean.json)
and [policy profile](profiles/robotwin-openpi.json). Set the shell variables below to the corresponding
local locations. The simulator uses SAPIEN ray tracing with OIDN, CUDA and the native cuRobo planner.
Set `CUDA_ARCH` to the target GPU's compute capability if it differs from the default 8.0.
The policy build uses the OpenPI serving dependency image from the LIBERO setup.

```bash
hf download TianxingChen/RoboTwin2.0 embodiments.zip objects.zip --repo-type dataset \
  --revision 3dc3b798668feb99ac61cc9086d84cbcc3d79186 --local-dir "$ROBOTWIN_ARCHIVES"
python3 -B examples/bench-adapters/embodied/prepare_robotwin_assets.py \
  --archives "$ROBOTWIN_ARCHIVES" --output "$ROBOTWIN_ASSETS"

hf download niejunnan25/pi05-robotwin --revision a51103c8812e98b1828e8d511847750483ad96d2 \
  --include 'adjust_bottle/*' --local-dir "$ROBOTWIN_MODEL_DOWNLOAD"
hf download niejunnan25/pi05-robotwin tokenizer.model --revision a51103c8812e98b1828e8d511847750483ad96d2 \
  --local-dir "$ROBOTWIN_MODEL_DOWNLOAD"

docker build --label orbit.task=robotwin --target simulator \
  --build-arg CUDA_ARCH="${CUDA_ARCH:-8.0}" \
  --build-context robotwin="$ROBOTWIN_SOURCE" --build-context curobo="$CUROBO_SOURCE" \
  --build-context openpi="$ROBOTWIN_OPENPI" -f examples/bench-adapters/embodied/robotwin.Dockerfile \
  -t orbit/robotwin-simulator:reference .
docker build --label orbit.task=robotwin --target policy \
  --build-context openpi="$ROBOTWIN_OPENPI" --build-context tokenizer="$ROBOTWIN_MODEL_DOWNLOAD" \
  -f examples/bench-adapters/embodied/robotwin.Dockerfile -t orbit/robotwin-policy:reference .
```

For a machine with an existing CUDA 12.4 toolkit, add
`--build-context cuda-toolkit="$CUDA_124_TOOLKIT" --build-arg CUDA_TOOLKIT_SOURCE=/` to the
simulator build. The toolkit directory must contain `bin`, `include`, and `lib64`.
A local wheel cache for Torch 2.4.1+cu124 can be passed with
`--build-context torch-wheels="$ROBOTWIN_TORCH_WHEELS"`.

The asset preparation step verifies both published archives, extracts Aloha-AgileX and the bottle
assets with the required object indices, and resolves the planner templates to a fixed path inside the simulator image. Orbit
mounts the asset tree and the inference checkpoint as separate read-only named datasets.

## Register and calibrate

```bash
ROBOTWIN_WEIGHTS="$ROBOTWIN_MODEL_DOWNLOAD/adjust_bottle"
python3 -B examples/bench-adapters/embodied/configure_robotwin.py benchmark \
  --robotwin-source "$ROBOTWIN_SOURCE" --assets "$ROBOTWIN_ASSETS" \
  --benchmark-image orbit/robotwin-simulator:reference --output-dir "$ROBOTWIN_CONFIG"
python3 -B examples/bench-adapters/embodied/configure_robotwin.py policy \
  --openpi-source "$ROBOTWIN_OPENPI" --weights "$ROBOTWIN_WEIGHTS" \
  --policy-image orbit/robotwin-policy:reference --share-gpu --output-dir "$ROBOTWIN_CONFIG"
orbit data add robotwin-demo-clean-assets "$ROBOTWIN_ASSETS"
orbit data add pi05-robotwin-adjust-bottle "$ROBOTWIN_WEIGHTS"
orbit bench add-file "$ROBOTWIN_CONFIG/benchmark.json"
orbit policy add "$ROBOTWIN_CONFIG/policy.json"
orbit bench tasks robotwin-demo-clean-native --json
```

Registration pins the source, images, checkpoint, normalization and simulator asset identities.
The shared recipe leases one Vulkan-capable GPU with 12 GB for the simulator and 32 GB for the
policy. Omit `--share-gpu` to use separate GPU roles and the policy name without `-shared`.

Create a sample plan with two scene seeds accepted by the native expert. The effective seed is
`environmentSeed + initialStateId`. The native development comparison accepted seeds 100001
and 100002 using seed base 100000 and initial-state offsets 1 and 2.

```bash
python3 -B examples/bench-adapters/embodied/plan.py --reference-source "$ROBOTWIN_SOURCE" \
  --reference-file "$ROBOTWIN_CONFIG/reference.json" --task adjust_bottle \
  --environment-seed 100000 --initial-state 1 --initial-state 2 > "$ROBOTWIN_CONFIG/samples.json"
orbit bench calibrate robotwin-demo-clean-native --policy pi05-robotwin-adjust-bottle-shared \
  --sample-plan "$ROBOTWIN_CONFIG/samples.json" --budget 20 --json
```

## Evaluation conditions

- RoboTwin checks each frozen seed with its expert, then resets the same scene for the policy.
  The pinned instruction generator uses the upstream `unseen` pool and a per-scene Python random
  seed. An unstable expert scene or failed expert check yields a `sample_rejected` invalid episode.
  The batch continues in frozen order, retaining that sample identity and leaving it out of success
  rates. Other reset errors stop the batch. Use expert-accepted seeds for calibration, which requires
  every planned sample to produce a valid result.
- The input is native 320 × 240 RGB from the head and both wrists, 14 joint and gripper values
  and one instruction. OpenPI-PACE performs resize and normalization. The controller receives
  up to 50 absolute actions per prediction in left arm, left gripper, right arm, right gripper
  order. The rollout ends on the native success flag or at 400 controls.
- A fixed batch shares one service and advances its JAX random stream in plan order. The verifier
  and rescore read per-episode evidence on CPU. The native-style score uses accepted, valid samples.
  Two frozen episodes establish integration coverage for this task. The full upstream protocol
  evaluates 100 accepted seeds per task.
  [Validation record](../../../docs/tasks/20261107-robotwin.md)
