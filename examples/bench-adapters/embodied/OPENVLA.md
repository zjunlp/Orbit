# OpenVLA-OFT and native LIBERO

The `openvla-ws` policy serves the public
[`moojink/openvla-7b-oft-finetuned-libero-spatial`](https://huggingface.co/moojink/openvla-7b-oft-finetuned-libero-spatial)
checkpoint using [official OpenVLA-OFT inference functions](https://github.com/moojink/openvla-oft).
It reuses Orbit's native LIBERO simulator, frozen semantic binding, fixed solve batches and
independent CPU verification. It does not import vla-eval or launch an upstream evaluation loop.

The default checkpoint supports **LIBERO Spatial**. `--model combined` selects the official
joint Spatial/Object/Goal/Long checkpoint; `--suite` selects its matching normalization key and
separate policy registration. See [suite selection](../../../docs/guides/libero-suites.md) for
downloads and registration. Its independent policy profile accepts
the same raw LIBERO observations and native actions as the existing policies. Camera rotation,
quaternion conversion, official JPEG/Lanczos resize, 90% center crop, proprioception normalization
and continuous L1 action head run in the model service. The client validates the entire raw
`(8, 7)` output before the driver converts the gripper to LIBERO's sign convention; evidence keeps
the raw output and verification recomputes the conversion. Calls have bounded
deadlines and are never retried automatically.

## Sources, weights and image

Keep resources and generated configuration outside the Orbit checkout. Set `OPENVLA_SOURCE`,
`OPENVLA_TRANSFORMERS_SOURCE`, `OPENVLA_DLIMP_SOURCE`, `OPENVLA_WEIGHTS`, `OPENPI_SOURCE` and
`LOCAL_OPENVLA_CONFIG` to your local locations. Use clean checkouts of the three repositories
and commits in `profiles/openvla-model.json`. The custom Transformers fork implements
bidirectional attention; substituting stock Transformers is unsupported.

The model image uses Python 3.10 with pinned Torch 2.2, TensorFlow 2.15 and inference dependencies.
The existing native benchmark image keeps its own Python runtime. Their communication carries
raw arrays over WebSocket, so the two Python environments do not need matching dependencies.

```bash
python3 examples/bench-adapters/embodied/fetch_openvla.py --output-dir "$OPENVLA_WEIGHTS"
python3 examples/bench-adapters/embodied/build_openvla.py \
  --openvla-source "$OPENVLA_SOURCE" --transformers-source "$OPENVLA_TRANSFORMERS_SOURCE" \
  --dlimp-source "$OPENVLA_DLIMP_SOURCE" --tag orbit/openvla-oft-policy:reference

# CPU-only deterministic helper comparison; no checkpoint inference is claimed by this audit.
docker run --rm --network none --label orbit.task=embodied-eval \
  orbit/openvla-oft-policy:reference /opt/orbit/audit_openvla.py
```

The downloader selects merged inference assets, including the L1 head and proprioception
projector, and checks each against the pinned public Hub content hash. The LoRA training adapter
is unnecessary. Re-running the command validates completed files and resumes partial transfers.
The launcher validates checkpoint and normalization digests, loads offline and permits the
official loader to rewrite only a temporary checkpoint view. Original assets are mounted read-only.
The frozen policy also carries `normalizationKey`; the client checks the server's selected key
before inference, so suites sharing a checkpoint and statistics file remain distinguishable.
TensorFlow image processing is restricted to CPU; Torch uses the leased GPU. The official
default attention implementation is retained, with no FlashAttention requirement added.

## Native benchmark recipe and registration

`profiles/openvla-libero.json` describes an OFT recipe for the existing native LIBERO adapter:
environment seed **0**, ten settle actions, 256-pixel renders, eight actions per model call and
a 220-step Spatial horizon. The separate registration is named `libero-oft-native`; it shares
the simulator and evidence implementation with `libero-native`. The OpenPI recipe keeps its
five-step replanning and seed 7. No pair-specific binding or simulator implementation is added.

Reuse the pinned OpenPI source and `libero-zmq` runtime from [README.md](README.md) and
[GR00T.md](GR00T.md). This is an explicit environment baseline: it uses robosuite 1.4.0, whereas
the official OFT LIBERO requirements specify 1.4.1. Deterministic helper checks and sampled real
episodes do not establish full official-runtime equivalence or reproduce published suite scores.
Different recipes are different evaluation conditions and cannot be treated as paired score
comparisons merely because they contain the same task names.

```bash
PYTHONPATH=examples/sdk python3 examples/bench-adapters/embodied/configure_openvla.py \
  --reference-source "$OPENVLA_SOURCE" --benchmark-source "$OPENPI_SOURCE" \
  --weights "$OPENVLA_WEIGHTS" --policy-image orbit/openvla-oft-policy:reference \
  --benchmark-image orbit/libero-zmq:reference --share-gpu --output-dir "$LOCAL_OPENVLA_CONFIG"

orbit data add openvla-oft-libero-spatial "$OPENVLA_WEIGHTS"
orbit policy add "$LOCAL_OPENVLA_CONFIG/policy.json"
orbit bench add-file "$LOCAL_OPENVLA_CONFIG/benchmark.json"
orbit bench tasks libero-oft-native --json

python3 examples/bench-adapters/embodied/plan.py --reference-source "$OPENPI_SOURCE" \
  --reference-file examples/bench-adapters/embodied/profiles/openvla-libero.json \
  --task "libero_spatial:$TASK_NAME" --initial-state 0 --initial-state 1 --environment-seed 0 \
  > "$LOCAL_OPENVLA_CONFIG/samples.json"
orbit bench calibrate libero-oft-native --policy openvla-oft-libero-spatial \
  --sample-plan "$LOCAL_OPENVLA_CONFIG/samples.json" --budget 20 --json
```

Configure resolves immutable image IDs and computes asset, recipe and implementation identities.
Regenerate registrations after source or image changes. With `--share-gpu`, the simulator and
model share one leased GPU with explicit budgets of 4 GB and 24 GB. Without it, CPU rendering
and an independent policy GPU role are used. Orbit owns the services, resource leases and cleanup.

The policy calibration uses 2–5 frozen samples and one model load, verifies each episode on CPU,
re-scores a selected episode, checks evidence identity and waits for cleanup. It checks integration,
not task success rate. Later batches use the same policy reference:

```bash
orbit bench run libero-oft-native --method oft=policy,policyRef=openvla-oft-libero-spatial \
  --sample-plan "$LOCAL_OPENVLA_CONFIG/samples.json" --batch-size 2
```

The service declares a seed-0 Torch stream. Each episode resets its simulator and local action
queue, while a shared batch continues the model service stream. There is no remote reseeding
claim, full-suite statistical validation or independent GPU-process bitwise-equivalence claim.

## RLinf LIBERO-90

Use `--model rlinf-90` with both the downloader and the registration command, and use `--suite libero_90` for registration. The dataset name is `openvla-oft-libero-rlinf-90`, the policy is `openvla-oft-rlinf-libero-90`, and the benchmark is `libero-oft-90-native`. Plan samples using the generated `reference.json`, `--suite libero_90` and environment seed `0`.

The pinned RLinf checkpoint uses the agentview camera and instruction, eight 7-D actions per call and `libero_90_no_noops_trajall` normalization. The policy image uses its discrete action-token decoder with temperature 1.6. Orbit evaluates it under its native OFT recipe with ten settle steps and a 400-step horizon. The RLinf evaluation config uses a different reset and episode budget, so its published scores refer to a separate recipe. [Checkpoint and inference settings](https://huggingface.co/RLinf/RLinf-OpenVLAOFT-GRPO-LIBERO-90) · [RLinf configuration](https://github.com/RLinf/RLinf/blob/e8a6c2ca23e0108218fd5c0e072169112cbcc301/examples/embodiment/config/libero_90_grpo_openvlaoft.yaml)
