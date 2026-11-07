# Independent GR00T and native SimplerEnv endpoints
branch: feat/embodied-eval · status: completed · updated: 2026-11-06

## Goal

Reuse the native LIBERO adapter with a second model family, and reuse the GR00T connector with
native SimplerEnv WidowX. Keep existing OpenPI evaluations and saved-evidence verification usable.

## Changes

- Pin GR00T code, simulator dependencies and checkpoint revisions; fetch inference-only assets from
  Hugging Face or checked ModelScope community mirrors. Resolve the backbone locally without modifying original assets.
- Add a bounded ZeroMQ connector with explicit action ordering, temporal axes, I/O codecs, execution
  horizon and Torch random-stream identity. Preserve existing Policy snapshots without new defaults.
- Reuse the OpenPI-pinned native LIBERO benchmark with the GR00T LIBERO codec; register four native
  SimplerEnv WidowX Visual Matching tasks through the same adapter and episode driver.
- Record native actions and explicit last/any success aggregation. Keep native termination and
  macro-step success behavior; verify frozen execution horizons and retain CPU-only saved-output rescore.
- Allow explicit model service `gpusOf: main` through the existing resource lifecycle. Include portable
  image recipes with NVIDIA EGL/Vulkan manifests and document the SDPA runtime and calibration limits.
- Keep downloaded sources, weights, provisioning logs and development run records outside Git.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Pinned asset verification | working tree | passed | All selected ModelScope files match NVIDIA's pinned public content identities |
| pnpm verify | working tree | passed | 696 tests passed; 26 existing skips; format, lint, types, boundaries and builds passed |
| Python SDK checks | working tree | passed | 39 checks on Python 3.8 and 3.11, including synthetic transport, checksum/resume and Gym semantics |
| Native simulator provisioning | working tree | passed | All four WidowX tasks reset, render and execute native steps; missing EGL/Vulkan manifests diagnosed and fixed |
| Real GR00T endpoints | working tree | passed | Sampled native LIBERO and WidowX positives; explicit stateless WidowX negative; independent verification |
| Resource lifecycle | working tree | passed | Real model/simulator share one leased GPU; explicit shared-GPU calibration service cancellation cleans up and releases lease |
| Saved-evidence compatibility | working tree | passed | New positive/negative CPU rescores and existing OpenPI positive/negative evidence rescores preserve solves and results |
| Full-suite statistics and upstream numerical parity | working tree | not_run | Sample checks do not establish either claim |

## Next / open issues

[Fixed solve batches and database migration](20261106-embodied-batches.md) are now implemented;
[real GR00T batch checks](20261106-groot-batches.md) cover both native endpoints. Broader embodiments,
checkpoint families, complete-suite calibration and numerical parity need their own validation.
