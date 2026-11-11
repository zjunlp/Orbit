# Decouple bench core from specific benchmarks, split calibration and trial views
branch: refactor/bench-core-decoupling · status: completed · updated: 2026-11-11

## Goal

Act on the audit in [20261111-drop-legacy-categories](20261111-drop-legacy-categories.md) where it helps
new benchmarks plug in: no benchmark names in the bench core, Orbit errors told apart from scorer
errors, calibration out of `BenchService`, one way to load trial files, and kind- and route-driven Web
views instead of hand-kept `if` chains.

## Changes

- **Benchmark-specific code leaves the core.** The EFE MetaWorld+ trajectory import moved from
  `BenchService.score()` into the Harbor adapter's `score` (loaded on demand; `adapterMain` now awaits
  handlers). ASI admission uses only its declared `capabilities.methods`; `asiMethodProblem` and the
  name checks in `service.ts` and `hub.ts` are gone. Error text is now the generic
  `<benchmark> does not support <agent> methods`. New `runAgentDir(output)` in `config/paths.ts`.
- **Scoring errors.** An `AdapterError` (adapter process or reply) stays `scorer_error`; any other
  exception while scoring is `failure: "infra"`, issue `score: Orbit error: …`, logged with its stack.
- **Calibration lifecycle** (`bench/calibration.ts`, `CalibrationLifecycle`): rescore after trials,
  policy budget timers, expiry and execution-end settlement, report and `ownedRuns`. Same behavior;
  `BenchService` public API unchanged. `service.ts` 1,625 → 1,499 lines.
- **Web trial views.** `lib/run-file.ts` (`useRunFile`, `readRunFile`) replaces four copies of listing
  lookup, size guard, fetch and parse; each view keeps its limit (2 MiB, 16 MiB for conversations) and
  messages. `pages/trial/Review.tsx` holds `FILE_VIEWS: Record<Kind, …>` (a new kind fails type checks
  until it has a view), Grader items and Details; `pages/trial/Legacy.tsx` holds the no-review tabs.
  `Trial.tsx` 1,017 → 633 lines. A plain-file view now reports a failed output listing instead of
  loading forever.
- **Web pages.** `src/routes.ts` defines every page once (path, rail group, `g x` key, palette text);
  App routing, rail, hotkeys, help and the palette are derived from it. Unknown paths show
  "Page not found" instead of Overview; `legacyHref` redirects still run first.
- Not changed: restart recovery by tag (`claimedSolve`) already has single-trial and batch adoption
  tests; the trial state machine stays in `service.ts`; Catalog memoization and later Web items.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | branch head | passed | orbit 752 passed / 28 skipped, web 114 passed; boundaries ok |
| Scoring error split | branch head | passed | `bench-service.test.ts`: AdapterError → `scorer_error`, no log; TypeError → `infra`, one log line |
| ASI admission by capabilities | branch head | passed | unit, compatibility matrix and daemon submission (kimi-cli and external rejected) |
| Cleanup ordering | branch head | passed | new `cleanup.test.ts`: failed removal keeps the lease, one event; success releases it (docker and process) |
| EFE import in Harbor `score` | branch head | passed | unit test, plus a real `__adapter harbor score` subprocess against `src/bin.ts` and the built `dist/cli.mjs` on a temporary fixture |
| Web routes, run files, kind registry | branch head | passed | new `routes.test.tsx` |
| Real Docker / GPU / Agent runs | — | not_run | no execution path changed; scoring was checked through the adapter subprocess only |
| Running daemon | — | not_run | the local daemon still runs the previous build until restarted |

## Next / open issues

- Split the trial state machine (`stepPending` / `stepSolving` / `stepVerifying` / batches) out of `service.ts`.
- Catalog filter memoization; abort stale `useAsync` requests; virtualize long conversations.
