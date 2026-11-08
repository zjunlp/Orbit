# GR00T and OpenVLA-OFT endpoints, native SimplerEnv WidowX
branch: feat/embodied-eval · status: completed · updated: 2026-11-07

## Goal
Reuse native LIBERO with more model families (GR00T N1.7, OpenVLA-OFT) and the GR00T connector with native SimplerEnv WidowX, keeping OpenPI evaluations and saved-evidence verification usable.

## Changes
- GR00T: pinned code, simulator dependencies and checkpoint revisions; inference-only assets from Hugging Face or checked ModelScope mirrors; backbone resolved locally without modifying originals.
- Bounded ZeroMQ connector with explicit action ordering, temporal axes, I/O codecs, execution horizon and Torch random-stream identity; existing Policy snapshots get no new defaults.
- Action validation before conversion: time indices must be the dense zero-based prediction window; the full chunk must be numeric and finite before gripper conversion. Rejected arrays are archived without pickle, with source observation and diagnostics, and kept out of scores.
- Native LIBERO reused with a GR00T codec. The SimplerEnv WidowX Visual Matching catalog has seven tasks (including sink, open-drawer and close-drawer) with pinned dependencies; existing jobs keep frozen benchmark snapshots.
- Native actions and explicit last/any success aggregation are recorded; native termination and macro-step success are kept; frozen horizons are verified; CPU-only rescore is retained.
- Model service `gpusOf: main` through the existing resource lifecycle. Portable image recipes include NVIDIA EGL/Vulkan manifests; the SDPA runtime and calibration limits are documented.
- Reference controls run the OpenPI LIBERO loop with a GR00T transport boundary and the NVIDIA WidowX loop with its multistep wrapper. This compares registered native protocols, not NVIDIA's published LIBERO scores.
- OpenVLA-OFT: public LIBERO Spatial checkpoint as an independent policy with pinned official sources; preprocessing and action conversion stay in the endpoint; native simulator, evidence, batch and CPU verification reused with an explicit OFT recipe; portable download/image/registration instructions.
- Sources, weights, provisioning logs and run records stay outside Git.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Pinned asset verification | working tree | passed | ModelScope files match NVIDIA's pinned public content identities |
| `pnpm verify` | working tree | passed | Latest: 753 tests, 26 existing skips; format/lint/types/boundaries/build |
| Python 3.8 / 3.11 SDK | working tree | passed | Latest 57 each; synthetic ZeroMQ/OpenVLA transport, checksum/resume, Gym semantics, raw-action boundaries |
| Action validation regressions before fix | bb0b234 + tests | passed | Reproduced timing acceptance and infinite gripper outputs admitted as valid |
| Isolated CPU driver Run | working tree | passed | 22 driver/transport checks in native Gym image; synthetic endpoints, no model/simulator |
| Native WidowX provisioning and seven-task preflight | 61f8263 + catalog update | passed | Every task resets, renders and executes native controls; missing EGL/Vulkan manifests fixed |
| Real GR00T endpoints | working tree | passed | Sampled LIBERO and WidowX positives, explicit stateless WidowX negative, independent verification |
| Shared-GPU resource lifecycle | working tree | passed | Model and simulator share one leased GPU; cancellation cleans up and releases lease |
| Saved-evidence compatibility | working tree | passed | New and existing OpenPI/GR00T positive and calibration evidence rescored on CPU; solves and results kept |
| Real model GPU inference after action validation | working tree | not_run | Protocol checks use CPU endpoints; weights and simulator unchanged |
| Initial reference metadata decoder | working tree | failed | Harness decoded an already-deserialized object; failed before inference |
| GR00T reference boundary controls | working tree | passed | Both live two-episode paths complete; later-episode trace lengths differ, so no bitwise verdict |
| OpenVLA-OFT deterministic I/O comparison | working tree | passed | Real model-image dependencies; official image/state and native-action helper values matched |
| OpenVLA-OFT bounded policy calibration | working tree | passed | Official merged checkpoint, shared load, native LIBERO, independent CPU verify, selected rescore, cleanup |
| Complete paired suites | working tree | not_run | A full statistical study needs its own scope and compute budget |

## Next / open issues
Full-suite statistical equivalence, upstream numerical parity, full official-runtime parity and independent-process bitwise repeatability remain unverified and are separate verdicts. Generated registrations need the new implementation digest; saved evidence keeps its original identity.
