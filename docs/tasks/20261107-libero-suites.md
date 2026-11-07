# LIBERO Object, Goal and Long coverage
branch: feat/embodied-eval · status: completed · updated: 2026-11-07

## Goal
Extend native LIBERO coverage to Object, Goal and Long for pi05, GR00T N1.7 and OpenVLA-OFT using matching official checkpoints.

## Changes
- Share suite identifiers, registration names and horizons between configuration tools and the native driver; preserve Spatial defaults.
- Reuse pi05's multi-suite checkpoint and select GR00T's matching official suite subfolder. Give shared-GPU pi05 a separate policy alias.
- Add the pinned official joint OFT checkpoint selector, matching action/proprioception heads and explicit per-suite normalization keys.
- Freeze optional `normalizationKey` in the policy definition, verify the service handshake before inference and display it in trial configuration; retain old snapshots without adding defaults.
- Reuse existing native simulation, bindings, fixed batches and CPU verification. Document suite registration, recipe differences and verification limits in the [suite guide](../guides/libero-suites.md).

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | working tree | passed | 753 tests passed, 26 skipped; format, lint, types, boundaries and builds passed |
| SDK protocol/configuration tests | working tree | passed | 62 tests each on Python 3.8 and 3.11; synthetic endpoints/assets, including incorrect normalization-key rejection before inference |
| Source and inference asset checks | working tree | passed | Pinned source audits and whole-file upstream content hashes; matching statistics and checkpoint components |
| Native task coverage | working tree | passed | All 30 added tasks: official initial state, reset, settle, raw RGB/state and a real native control step; horizons 280/300/520 |
| New model/suite integration checks | working tree | passed | All nine combinations, two frozen episodes each; one model load per batch, independent CPU verification, selected rescore and confirmed cleanup/lease release |
| Joint OFT Spatial checkpoint | working tree | passed | Two additional real episodes with its own frozen suite normalization key; CPU verification, selected rescore and cleanup |
| Independent code review and guide links | working tree | passed | No actionable correctness findings; edited relative links and staged whitespace checks passed |
| Whole-suite performance and official-runtime/statistical parity | working tree | not_run | Outside bounded integration acceptance; sampled checks do not establish equivalence |

## Next / open issues
- Full-suite statistical studies need a separately declared scope and compute budget.
- LIBERO-90 matching-checkpoint coverage is not included.
