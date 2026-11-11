# Drop legacy categories from code, and audit hotspots
branch: refactor/drop-legacy-categories · status: completed · updated: 2026-11-11

## Goal

Make the code match design §9.10: a benchmark is described by its six-dimensional taxonomy, its
integration and its calibration record. Remove the C1–C7 `category`, `profiles`, `kind`, the old
`domains` vocabulary, catalog `verification.level` and registration `fidelity` from contracts, and
stop deriving calibration expectations from the category. Record an audit of frontend and backend
hotspots for follow-up work.

## Changes

- Contracts: `BenchCapabilities` loses `category` / `profiles` / `domains` / `kind` (old adapter
  replies are still accepted; the keys are dropped). `parity` keeps evidence only, no level.
  `BenchLabels.domains`, `CatalogEntry.domains` / `tags` / `fidelity` and
  `SupportedBenchmark.verification.level` are gone. `contracts/categories.ts` and the
  `@zjunlp/orbit/categories` export are removed.
- Calibration: expectations are `CALIBRATION_DEFAULTS` (empty min, oracle max, exact repeats)
  overridden by the benchmark's `calibration`. Adapters that relied on a category default now declare
  it: native embodied, vla-eval and the LIBERO manifest `{empty: any, oracle: none, seedsVary}`,
  Chartography `{empty: any}`. Harbor keeps `{oracle: max}`.
- Migration 8 (database version 7 → 8) writes what each retired category implied into existing calibration jobs, so their
  reports do not change. Reading `benchmarks.json` turns label `domains` into taxonomy domains
  using the existing exact mapping (`embodied` → `robotics`, …).
- Harbor still accepts `-c category=… profiles=…` on old registrations; `category` stays a recorded
  condition so comparability digests of old jobs are unchanged.
- CLI: `bench show` prints score kind instead of category; `bench label --domain` is removed (use
  `--taxonomy`). Web: category filter, legacy domain filter, legacy chips, fidelity labels and the
  verification-level filter are removed; product cards show integration count and the checked facts.
- All example adapters declare `taxonomy` instead of `domains`; design, adapter guide, catalog and
  status updated.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | branch head | passed | orbit 747 passed / 28 skipped, web 107 passed |
| Adapter Python tests | branch head | passed | 18 adapters with `test_adapter.py`, `python3 -m unittest discover` each |
| Migration on a copy of the local database | branch head | passed | v7 → v8; 60/60 jobs parse; the 4 calibration jobs keep identical expectations; backup written |
| Real calibration / Docker runs | — | not_run | behavior is unchanged by construction (expectations equal before/after); no adapter execution path changed |

## Audit: urgent hotspots

Backend (read-only review of `packages/orbit/src`):

1. `bench/service.ts` (1,626 lines) mixes job CRUD, the trial state machine, calibration timers,
   scoring and trajectory import. Split the state machine (`stepPending` / `stepSolving` /
   `stepVerifying` / batches) and calibration into their own modules, the way `runs/` already did.
2. Benchmark-specific code in core: `service.ts` imports EFE trajectories by matching
   `adapter === "harbor" && task.startsWith("metaworldplus-")`; ASI admission is checked by adapter
   name in both `service.ts` and `hub.ts`. Route these through adapter capabilities.
3. Scoring errors: any exception around `adapter.score()` (including Orbit's own bugs) becomes an
   invalid trial with an issue string, indistinguishable from a scorer failure. Tag Orbit-side
   exceptions as infrastructure failures and log them.
4. Restart recovery relies on tag matching (`claimedSolve`) because the trial write and run
   submission are separate steps. Encapsulate or make linkage atomic before adding more phases.
5. No focused tests for `store/` transactions, `runs/cleanup.ts` ordering or `executor/docker.ts`;
   coverage is only through daemon/docker integration tests.

Frontend (read-only review of `packages/web/src`):

1. `pages/Trial.tsx` (1,017 lines) holds ~15 views and a closed `if` chain over review kinds; a new
   trial kind (GUI, embodied, evolution) edits this file. Add a kind → component registry and move
   views into `pages/trial/`.
2. Routing, navigation and hotkeys are three hand-kept lists in `App.tsx`; use one route table.
3. File previews repeat the fetch / size-guard / parse logic three times in `Trial.tsx`; extract one
   hook.
4. `bench/Catalog.tsx` (1,373 lines) recomputes filter chains on every render without memoization.
5. Later: `useAsync` ignores but does not abort stale requests; `Conversation.tsx` renders all turns
   without virtualization; one 2,132-line global stylesheet with ad hoc z-index values.

## Next / open issues

- Act on the audit, starting with backend items 1–2 and frontend item 1.
- `docs/research/` and historical task records keep their original terms.
