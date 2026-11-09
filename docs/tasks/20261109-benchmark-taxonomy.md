# Benchmark taxonomy v1 and catalog facets

branch: feat/benchmark-taxonomy-ui · status: completed · updated: 2026-11-09

## Goal

Define a controlled six-dimensional benchmark taxonomy and expose it in the Benchmarks page while
preserving benchmark identity, existing execution protocols and evidence boundaries.

## Changes

- Make design §9.17 the authoritative vocabulary: domains, task types, evaluation targets, interfaces
  and modalities, environment and interaction conditions, and scoring evidence and methods.
- Keep C1–C7 as integration and compatibility metadata. Keep Harbor and other packaging or runtime
  formats separate from what a task evaluates.
- Resolve and filter dimensions on the same task or variant before grouping benchmark identities;
  keep unknown metadata and evidence scope explicit.
- Add optional taxonomy to capability, registration and task declarations, with explicit inheritance,
  unknown and empty states. Catalog descriptor groups preserve conjunctions before identity grouping.
- Add six facet groups, URL filters, cards/list/domain-by-task matrix, registration taxonomy editing
  and legacy URL compatibility to Benchmarks. Keep calibration and method evidence registration-scoped.
- Add CLI taxonomy JSON/file input and verified protocol declarations for HumanEval and native
  embodied adapters. Preserve existing snapshots; exclude discovery metadata from execution comparison.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Vocabulary counts and documentation diff | working tree | passed | 12 domains, 14 task types, 14 targets, 11 interface/modality values, 15 environment/interaction values and 9 scoring values; whitespace check passed. |
| Orbit types and module boundaries | working tree | passed | `pnpm --filter @zjunlp/orbit typecheck` and `node scripts/boundaries.ts`. |
| Taxonomy, service and hub tests | working tree | passed | 60 targeted tests; a later taxonomy-only run passed 7 tests including the CLI label-preservation case. |
| Python adapter tests | working tree | passed | 16 embodied adapter/suite tests and 4 HumanEval tests; explicit fixtures and the actual HumanEval checker, without Docker or model calls. |
| `pnpm verify` | working tree | passed | 810 tests passed (5 scripts, 709 Orbit, 96 Web); 26 opt-in tests skipped; 9 existing lint warnings. Types, boundaries and builds passed. |
| Browser review | working tree | passed | Eight check groups using synthetic metadata fixtures, with no page errors: six-dimensional URL filters; cross-field/unknown/legacy matching; matrix/list/search/sort; explicit-default editing, failed-save retention and Escape/focus handling; one forced refresh; initial API error/retry; light/dark layouts at 390/768/1280/1512 px without horizontal overflow; mobile filters and dialogs. No benchmark score claims. |
| Isolated real daemon HTTP and restart | working tree | passed | Two successive daemon processes with temporary home/data; two synthetic task groups checked registration, default/task overrides, null/empty/inheritance restoration, variant preservation and persistence after restart. Invalid vocabulary returned HTTP 400 without changing the record. No jobs or model calls; both daemons stopped. |
| Real Docker/GPU evaluation | working tree | not_run | This change describes and filters benchmarks; no execution change is intended. |

## Next / open issues

- Other adapters can add annotations incrementally from documented protocol facts; unspecified fields
  and old records retain unknown values rather than inferred labels.
- No per-task historical taxonomy snapshot or new execution protocol is introduced. Calibration and
  method evidence remain registration-scoped. Overview retained legacy category coverage at this
  task's completion; its replacement is tracked in [the homepage and dimension-card follow-up](20261109-benchmark-category-cards.md).
