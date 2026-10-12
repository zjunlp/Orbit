# Rescore bench trials without rerunning the Agent

branch: feat/bench-rescore · status: completed · updated: 2026-10-08

## Goal

After a grader or scorer fix, score finished trials again from their saved solve output: a new
verify run per trial, no new solve run, and both the earlier and the new scoring kept.

## Changes

- Contracts: `Scoring`, `Trial.history` (earlier `{verifyRunId, outcome, endedAt}`, oldest first;
  `verifyRunId` / `outcome` stay the latest), `trialRunIds`, `BenchRescore` / `BenchRescoreResult`.
- `BenchService.rescore(job, {tasks, methods, trials})`: only jobs that have ended; trials that are
  done, whose solve run still has its output here and needed verification. The trial goes back to
  `solving` and the existing state machine asks the adapter for a new verify spec (staging is rebuilt
  from the solve output), runs and scores it. The job's state is untouched; a cancelled job does not
  cancel its rescore. Verify issues are de-duplicated (the same solve output gives the same issues).
- Store: migration 4, `trial_runs` (every run a trial has had; backfilled), so `trialByRun`, moving
  and deleting a job include earlier verify runs.
- API `POST /bench/jobs/:id/rescore`, client `benchRescore`, CLI `orbit bench rescore <job> [-t] [-m]
  [--trial]`; `bench show` prints `1/1 (was 0.5)`.
- Web: Rescore on the job page (finished jobs) and the trial page; "Earlier scorings" with a link to
  each earlier verify run; matrix cells say "rescoring" / "rescored; earlier: …".
- Docs: design §7, adapter guide (verify must be repeatable), `orbit` skill.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Daemon test (rescore, history, refusals, job deletion with old verify run) | working tree | passed | `test/bench.daemon.test.ts`, process-backend external adapter |
| `pnpm verify` | working tree | passed | |
| Migration on an isolated database copy | working tree | passed | Trial/run links preserved; lookup by verify run works |
| Real Harbor job + rescore (Docker) | this machine | passed | throwaway daemon; oracle 0.5 → grader changed → rescore 1, same solve run, history 0.5 |
| Web job / trial page | this machine | passed | headless Chromium screenshots: Rescore buttons, earlier scorings row |

## Next / open issues

- RCB rescore with an LLM judge remains unverified.
- No rescore while a job is still running; rescoring cannot be cancelled as a whole (cancel its
  verify runs instead).
