# Embodied audit recovery

branch: feat/embodied-eval · status: completed · updated: 2026-11-22

## Goal

Resolve the confirmed branch regressions with independently reviewed changes.

## Changes

- Restore the pre-change rules for batch consolidation. A mixed target cannot
  adopt only the failed members from an all-valid shared retry. Full replacements
  and pruning all-invalid retry sources remain covered.
- Bind legacy vla-eval Verify receipts to their saved trial parameters and original
  Solve output. New generic Verify runs carry a command flag and require a complete
  structured receipt.
- Add native task IDs to duplicate LIBERO-Plus names on the SDK adapter route.
  The staged wrapper and Verify use the same native ID.
- Check model assets again at the published path before declaring success.
  Omit timeout advice for rows containing shared Solve measurements.
- Check the origin of BEHAVIOR's AgentMetric. Require expected field types and
  the recorded seed in the declarative LIBERO Spatial manifest.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | reviewed changes | passed | Format, types, boundaries, tests and build. |
| Python 3.11 | reviewed changes | passed | SDK 196 passed and one skipped. Native adapters 79 passed and six skipped. |
| vla-eval | reviewed changes | passed | 22 tests each on Python 3.8 and 3.11. Independent review replayed original and current Verify receipts. |
| Targeted reproductions | reviewed changes | passed | Real SQLite and trajectory selection, localhost HTTP with two writers, CPU Docker import probe, and the full 2,402-task LIBERO-Plus Spatial catalog. |
| GPU rollout | reviewed changes | not_run | Checks covered planning, artifact validation and evidence ownership. |

## Next / open issues

- The restored consolidation baseline can still split evidence when pruning
  an already-mixed shared donor. Pruning can also discard an unknown historical
  attempt from a now-invalid donor.
- Completed-run resource advice cannot account for pending shared jobs. The
  download checksum covers the observed published bytes. Later concurrent
  writes still require a separate coordination change.
- Old generic Verify runs sharing the same command cannot be distinguished
  retroactively. For LIBERO, a unique task name still lacks a frozen native ID,
  and the declarative manifest validates the recorded seed only. The upstream
  model server can advertise a separate runtime environment seed.
