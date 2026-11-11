# Move the trial state machine out of BenchService
branch: refactor/bench-trial-machine · status: completed · updated: 2026-11-11

## Goal

Give the trial state machine its own module so changes to trial phases (multi-step tasks, environment
pools, Agent evolution loops) touch one file with an explicit interface to job-level operations.
Pure move: no behavior change.

## Changes

- New `bench/trials.ts` with `TrialMachine`: advancing trials, solve / batch / verify submission,
  scoring, cancellation of live Runs, restart claiming of live solves, cleanup reconciliation.
- `BenchService` keeps job-level operations (submit, calibrate, catalog, rescore, consolidate,
  cancel, delete, export, reports) and reaches trials only through `isBusy`, `advanceAll`,
  `stopRuns`, `captureLiveSolves` / `hasLiveSolves`, `agentFailure`, `hasEpisodeEvidence`,
  `reconcileCleanup` and `onRun`. The machine gets benchmark lookup, adapter, Agent definitions and
  report writing as injected functions, the same way `CalibrationLifecycle` does.
- `service.ts` 1,499 → 930 lines; `trials.ts` 639 lines. Public API and contracts unchanged.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Moved code equals the original | branch head | passed | diff of the old section against `trials.ts`: only the injected-function renames, report writing kept in the service, one doc comment moved back to its function, formatting |
| Bench suites | branch head | passed | bench-service, policy-calibration, embodied(-batches), bench(.daemon), coverage-calibrate, agent-bench, trajectory: 178 passed |
| `pnpm verify` | branch head | passed | orbit 752 passed / 28 skipped, web 114 passed; boundaries ok |
| Real Docker / Agent runs | — | not_run | no execution path changed |

## Next / open issues

- None from this move; new trial phases should extend `TrialMachine` rather than `BenchService`.
