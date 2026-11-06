# GR00T N1.7 and native SimplerEnv

GR00T is an independent Policy registration using the official ZeroMQ inference server. The
existing native LIBERO adapter accepts its raw LIBERO profile through an explicit model-side
codec. The same connector also accepts flat, ordered observations from NVIDIA's pinned native
SimplerEnv wrapper. Neither path imports vla-eval or starts an upstream rollout scheduler.

`profiles/groot-model.json` pins the model implementation and NVIDIA checkpoint revisions.
`profiles/groot-widowx.json` pins the SimplerEnv/ManiSkill source, seven WidowX Visual Matching
tasks, control semantics and success reduction. LIBERO keeps `reference.json`, including its
OpenPI-pinned simulator, 10 settle steps, suite horizons and 5-step replanning. The GR00T LIBERO
checkpoint supplied here is trained for `libero_spatial`; this configuration does not reproduce
NVIDIA's distinct LIBERO evaluation protocol or claim statistical parity with its published scores.

## Assets and images

Keep source checkouts, weights, generated registrations and logs outside the Orbit checkout.
Set `GROOT_SOURCE`, `GROOT_ASSETS`, `LOCAL_GROOT_CONFIG` and `OPENPI_SOURCE` locally. Check out
Isaac-GR00T at the commit in `profiles/groot-model.json`, with its pinned SimplerEnv and nested
ManiSkill submodules. The existing OpenPI source/runtime from [README.md](README.md) is reused
for LIBERO; do not replace its LIBERO submodule with NVIDIA's revision.

```bash
python3 examples/bench-adapters/embodied/fetch_groot.py --output-dir "$GROOT_ASSETS"
# Alternatively, use the public nv-community ModelScope mirrors:
python3 examples/bench-adapters/embodied/fetch_groot.py --source modelscope \
  --output-dir "$GROOT_ASSETS"

docker build --label orbit.task=embodied-eval -f examples/bench-adapters/embodied/groot-base.Dockerfile \
  -t orbit/groot-deps:reference .
docker build --label orbit.task=embodied-eval --build-context groot="$GROOT_SOURCE" \
  --build-arg POLICY_BASE=orbit/groot-deps:reference \
  -f examples/bench-adapters/embodied/groot-policy.Dockerfile -t orbit/groot-policy:reference .
docker build --label orbit.task=embodied-eval --build-context groot="$GROOT_SOURCE" \
  -f examples/bench-adapters/embodied/native-gym.Dockerfile -t orbit/simpler-native:reference .
docker build --label orbit.task=embodied-eval --build-arg BENCHMARK_BASE=orbit/libero-native:reference \
  -f examples/bench-adapters/embodied/libero-zmq.Dockerfile -t orbit/libero-zmq:reference .
```

The downloader selects inference assets only, resumes partial files, and validates each file
against NVIDIA's pinned public Hugging Face content identity. ModelScope is a community mirror;
its owner name is not treated as proof of provenance. `HF_TOKEN`, when needed for the Hugging Face
source, is read from the environment. `--direct-download` bypasses proxy variables only for asset
transfers, while metadata requests retain the usual environment settings.

The launcher validates the original checkpoint, statistics and backbone cache before loading.
It derives temporary metadata pointing at the pinned local backbone snapshot, because this
Transformers version can query remote model metadata even in offline mode when given a Hub ID.
Original assets remain read-only; model tensors and preprocessing parameters are unchanged.
The supplied runtime uses PyTorch SDPA when flash-attn is absent. Runtime versions and upstream
backend selection messages remain in service logs; no numerical parity claim follows from loading.

## Register and run

```bash
PYTHONPATH=examples/sdk python3 examples/bench-adapters/embodied/configure_groot.py \
  --reference-source "$GROOT_SOURCE" --benchmark-source "$OPENPI_SOURCE" \
  --weights "$GROOT_ASSETS" --profile libero \
  --policy-image orbit/groot-policy:reference --benchmark-image orbit/libero-zmq:reference \
  --output-dir "$LOCAL_GROOT_CONFIG/libero"
PYTHONPATH=examples/sdk python3 examples/bench-adapters/embodied/configure_groot.py \
  --reference-source "$GROOT_SOURCE" --weights "$GROOT_ASSETS" --profile widowx --share-gpu \
  --policy-image orbit/groot-policy:reference --benchmark-image orbit/simpler-native:reference \
  --output-dir "$LOCAL_GROOT_CONFIG/widowx"

orbit data add groot-n17 "$GROOT_ASSETS"
orbit policy add "$LOCAL_GROOT_CONFIG/widowx/policy.json"
orbit bench add-file "$LOCAL_GROOT_CONFIG/widowx/benchmark.json"
python3 examples/bench-adapters/embodied/plan.py --reference-source "$GROOT_SOURCE" \
  --reference-file examples/bench-adapters/embodied/profiles/groot-widowx.json \
  --task simpler_env_widowx/widowx_spoon_on_towel --initial-state 0 --environment-seed 7 \
  > "$LOCAL_GROOT_CONFIG/widowx/samples.json"
orbit bench run simpler-widowx-native --method groot=policy,policyRef=groot-n17-widowx \
  --sample-plan "$LOCAL_GROOT_CONFIG/widowx/samples.json"
```

Configure resolves immutable Docker image IDs and computes all asset/implementation digests.
Regenerate the registrations after code or image changes. Registering the generated LIBERO file
updates `libero-native` to the runtime with ZeroMQ support; prior jobs retain their frozen snapshots.

Without `--share-gpu`, the model has an independent GPU role. With it, the model explicitly uses
`gpusOf: main`, sharing the simulator's already leased GPU; Orbit still owns scheduling and cleanup.
Both modes retain the model's 24 GB per-GPU budget. GPU simulators declare a separate 4 GB budget,
configurable with `--sim-gpu-mem-gb`. Shared budgets add on the owning role, so the default shared
configuration requires a nominal capacity of at least 28 GB per card; separate roles retain their
individual budgets. These are capacity admission estimates; tune the simulator budget for the task.
Insufficient node capacity fails preflight, while a fitting card that is busy or leased causes waiting.
WidowX needs a working SAPIEN Vulkan renderer. The image supplies generic NVIDIA EGL/Vulkan
manifests and requests graphics/compute/utility capabilities; no host driver paths are embedded.

WidowX reset uses `environmentSeed + initialStateId` as a generated environment seed, not an
index into a LIBERO initial-state file. Its horizon is 300 control steps at 5 Hz, replanning every
4 steps. Success is any native `info.success`; native termination ends immediately, while a success
signal without termination ends at the action chunk boundary. This follows the pinned wrapper.
Evidence records both policy and native actions.
Each solve Run starts a fresh model with Torch seed 0 after loading. With `--batch-size`, the
model remains loaded across the fixed group; each episode resets its environment and connector,
while the declared service random stream continues in order. Calls have deadlines and are never
retried. Saved-evidence verification runs separately per episode on CPU, without model or simulator
startup. See the [batch guide](../../../docs/guides/embodied-batches.md) for retry and cancellation scope.

The connector requires dense action time indices `0..horizon-1` before inference. Raw predicted
actions must be numeric and finite before any gripper conversion, including rows outside the
executed prefix. Rejected numeric arrays remain in `chunks/<call>.rejected.npy` with pickle disabled;
the companion JSON identifies the source observation and rejection reason. Unsupported values
receive a bounded text preview. Such calls produce an invalid `policy_act` result without executing
the rejected chunk; earlier completed controls remain available for review and verification.

`fixtures/zero_groot.py` is an explicit stateless calibration policy, not a GR00T model substitute.
The source profiles deliberately do not certify full-suite calibration or statistical parity.
