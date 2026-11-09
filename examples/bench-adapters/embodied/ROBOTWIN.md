# Native RoboTwin 2.0

The `robotwin-demo-clean-full-native` and `robotwin-demo-randomized-full-native` registrations
each expose the 50 upstream tasks on Aloha-AgileX. RoboTwin owns scene setup, expert feasibility,
joint control, task-specific horizons and `eval_success`. The two registrations freeze separate
native configuration and asset identities.
[Benchmark](https://github.com/RoboTwin-Platform/RoboTwin) · [Official protocol](https://robotwin-platform.github.io/leaderboard)

## Prepare the runtimes and assets

Keep checkouts, archives, weights and generated configurations outside the Orbit checkout.
Check out RoboTwin, cuRobo and OpenPI-PACE at the commits in the [benchmark profile](profiles/robotwin-demo-clean.json)
and [policy profile](profiles/robotwin-openpi.json). Set the shell variables below to the corresponding
local locations. The simulator uses SAPIEN ray tracing with OIDN, CUDA and the native cuRobo planner,
and includes the OpenPI client for the socket connector.
Set `CUDA_ARCH` to the target GPU's compute capability if it differs from the default 8.0.
The policy build uses the OpenPI serving dependency image from the LIBERO setup.

```bash
hf download TianxingChen/RoboTwin2.0 embodiments.zip objects.zip background_texture.zip --repo-type dataset \
  --revision 3dc3b798668feb99ac61cc9086d84cbcc3d79186 --local-dir "$ROBOTWIN_ARCHIVES"
# Set ROBOTWIN_SUITE to demo_clean or demo_randomized and use separate output directories.
python3 -B examples/bench-adapters/embodied/prepare_robotwin_assets.py \
  --suite "$ROBOTWIN_SUITE" --archives "$ROBOTWIN_ARCHIVES" --output "$ROBOTWIN_ASSETS"

docker build --label orbit.task=robotwin --target simulator \
  --build-arg CUDA_ARCH="${CUDA_ARCH:-8.0}" \
  --build-context robotwin="$ROBOTWIN_SOURCE" --build-context curobo="$CUROBO_SOURCE" \
  --build-context openpi="$ROBOTWIN_OPENPI" -f examples/bench-adapters/embodied/robotwin.Dockerfile \
  -t orbit/robotwin-simulator:reference .
```

For a machine with an existing CUDA 12.4 toolkit, add
`--build-context cuda-toolkit="$CUDA_124_TOOLKIT" --build-arg CUDA_TOOLKIT_SOURCE=/` to the
simulator build. The toolkit directory must contain `bin`, `include`, and `lib64`.
A local wheel cache for Torch 2.4.1+cu124 can be passed with
`--build-context torch-wheels="$ROBOTWIN_TORCH_WHEELS"`.

Asset preparation verifies the published archive hashes and extracts Aloha-AgileX and the complete
object tree. Randomized adds the native unseen backgrounds for evaluation, so Clean installations
can skip the background archive. The planner templates resolve to a fixed path in the simulator
image. Registration verifies the assembled asset tree against the suite's pinned digest.

## Register a suite and plan samples

```bash
ROBOTWIN_NAME="robotwin-${ROBOTWIN_SUITE/_/-}-full-native"
python3 -B examples/bench-adapters/embodied/configure_robotwin.py benchmark \
  --suite "$ROBOTWIN_SUITE" --robotwin-source "$ROBOTWIN_SOURCE" --assets "$ROBOTWIN_ASSETS" \
  --benchmark-image orbit/robotwin-simulator:reference --output-dir "$ROBOTWIN_CONFIG"
orbit data add "robotwin-${ROBOTWIN_SUITE/_/-}-full-assets" "$ROBOTWIN_ASSETS"
orbit bench add-file "$ROBOTWIN_CONFIG/benchmark.json"
orbit bench tasks "$ROBOTWIN_NAME" --json
```

Omit `--suite` in both asset preparation and registration to reproduce the legacy
`robotwin-demo-clean-native` and its single `adjust_bottle` task. Register those legacy
assets under `robotwin-demo-clean-assets`.

The native planner uses the evaluator's candidate stream starting at `100000 * (1 + seed)`.
It runs the upstream expert in order for each task and freezes only the first accepted scenes.
By default it selects all 50 tasks and 100 accepted scenes per task. Use an explicit small task
and trial selection for integration checks. Set `ROBOTWIN_GPU` to the Docker GPU index or UUID.

```bash
docker run --rm --label orbit.task=robotwin --network none --gpus "device=$ROBOTWIN_GPU" \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD:/orbit-source:ro" -v "$ROBOTWIN_ASSETS:/opt/robotwin/assets:ro" \
  -v "$ROBOTWIN_CONFIG:/config" orbit/robotwin-simulator:reference \
  /orbit-source/examples/bench-adapters/embodied/plan_robotwin.py \
  --reference-file /config/reference.json --seed 0 --task adjust_bottle --trials 2 \
  --output /config/samples.json
```

The plan stores each seed as `environmentSeed + initialStateId`. Use [plan.py](plan.py)
to freeze known scene seeds directly. The native development comparison for Clean accepted
100001 and 100002. Accepted seeds and plan digests are specific to the suite.

## Register an independent policy

The published community OpenPI-PACE checkpoint is for `adjust_bottle`.
[Checkpoint](https://huggingface.co/niejunnan25/pi05-robotwin)

```bash
hf download niejunnan25/pi05-robotwin --revision a51103c8812e98b1828e8d511847750483ad96d2 \
  --include 'adjust_bottle/*' --local-dir "$ROBOTWIN_MODEL_DOWNLOAD"
hf download niejunnan25/pi05-robotwin tokenizer.model --revision a51103c8812e98b1828e8d511847750483ad96d2 \
  --local-dir "$ROBOTWIN_MODEL_DOWNLOAD"
docker build --label orbit.task=robotwin --target policy \
  --build-context openpi="$ROBOTWIN_OPENPI" --build-context tokenizer="$ROBOTWIN_MODEL_DOWNLOAD" \
  -f examples/bench-adapters/embodied/robotwin.Dockerfile -t orbit/robotwin-policy:reference .
ROBOTWIN_WEIGHTS="$ROBOTWIN_MODEL_DOWNLOAD/adjust_bottle"
python3 -B examples/bench-adapters/embodied/configure_robotwin.py policy \
  --openpi-source "$ROBOTWIN_OPENPI" --weights "$ROBOTWIN_WEIGHTS" \
  --policy-image orbit/robotwin-policy:reference --share-gpu --output-dir "$ROBOTWIN_CONFIG"
orbit data add pi05-robotwin-adjust-bottle "$ROBOTWIN_WEIGHTS"
orbit policy add "$ROBOTWIN_CONFIG/policy.json"
orbit bench calibrate "$ROBOTWIN_NAME" --policy pi05-robotwin-adjust-bottle-shared \
  --sample-plan "$ROBOTWIN_CONFIG/samples.json" --budget 20 --json
```

Policy registration pins the image, checkpoint and normalization independently of the benchmark.
The shared recipe leases one Vulkan-capable GPU with 12 GB for the simulator and 32 GB for the
policy. Omit `--share-gpu` to use separate GPU roles and the policy name without `-shared`.

## Evaluation conditions

- RoboTwin checks each frozen seed with its expert, then resets the same scene for the policy.
  The pinned instruction generator uses the upstream `unseen` pool and a per-scene Python random
  seed. Randomized resets start with fresh native clutter bounds so table biases cannot accumulate
  across scenes. An unstable expert scene or failed expert check yields a `sample_rejected` invalid episode.
  The batch continues in frozen order, retaining that sample identity and leaving it out of success
  rates. Other reset errors stop the batch. Use expert-accepted seeds for calibration, which requires
  every planned sample to produce a valid result.
- The input is native 320 × 240 RGB from the head and both wrists, 14 joint and gripper values
  and one instruction. OpenPI-PACE performs resize and normalization. The controller receives
  up to 50 absolute actions per prediction in left arm, left gripper, right arm, right gripper
  order. The rollout ends on the native success flag or at the task's upstream control limit.
- A fixed batch shares one service and advances its JAX random stream in plan order. The verifier
  and rescore read per-episode evidence on CPU. Full registrations average the per-task success
  rates of accepted, valid samples. The native board uses 100 accepted samples per task for
  each configuration.
  [Single-task validation](../../../docs/tasks/20261107-robotwin.md) · [Suite validation](../../../docs/tasks/20261108-robotwin-suites.md)

## X-VLA Cartesian evaluation

The [published X-VLA checkpoint](https://huggingface.co/2toINF/X-VLA-RoboTwin2/tree/a157c580cfe6f9f445614490f3bec1b2f9ef9f18)
uses the native Clean simulator and the Cartesian end-effector controller. The separate
`robotwin-demo-clean-cartesian-native` registration keeps the expert seed plan, camera images
and task oracle. It uses the reference client's task-name instruction, such as `adjust bottle`.
It follows the reference's limit of ten 30-action chunks and the native
per-task control limit. The service uses domain 6, three cameras, the last commanded poses
and live grippers. [X-VLA reference](https://github.com/2toinf/X-VLA/tree/6c4ecfb8be458ae7c0c96094e4b0add4174f4fe2/evaluation/robotwin-2.0)

Use the full Clean asset tree, the pinned X-VLA source checkout and the
[LeRobot policy base](NATIVE-EXPANSION.md#build-images-and-prepare-weights).

```bash
adapter=examples/bench-adapters/embodied
docker build --label orbit.task=robotwin --target simulator \
  --build-arg POLICY_BASE=orbit/embodied-lerobot-policy:0.5.1 \
  -f "$adapter/xvla-policy.Dockerfile" -t orbit/embodied-robotwin-cartesian:reference .
docker build --label orbit.task=robotwin --target policy \
  --build-arg POLICY_BASE=orbit/embodied-lerobot-policy:0.5.1 \
  -f "$adapter/xvla-policy.Dockerfile" -t orbit/embodied-xvla-policy:reference .

python3 -B "$adapter/configure_xvla.py" --robotwin-source "$ROBOTWIN_SOURCE" --xvla-source "$XVLA_SOURCE" \
  --assets "$ROBOTWIN_ASSETS" --weights "$XVLA_WEIGHTS" \
  --benchmark-image orbit/embodied-robotwin-cartesian:reference --policy-image orbit/embodied-xvla-policy:reference \
  --output-dir "$ROBOTWIN_CONFIG"
orbit data add robotwin-demo-clean-full-assets "$ROBOTWIN_ASSETS"
orbit data add xvla-robotwin2 "$XVLA_WEIGHTS"
orbit policy add "$ROBOTWIN_CONFIG/policy.json"
orbit bench add-file "$ROBOTWIN_CONFIG/benchmark.json"
```

Generate a sample plan with the new `reference.json` and the Clean seed search above.

```bash
orbit bench calibrate robotwin-demo-clean-cartesian-native --policy xvla-robotwin2 \
  --sample-plan "$ROBOTWIN_CONFIG/samples.json" --budget 20 --json
```
