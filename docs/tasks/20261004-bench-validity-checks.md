# Bench validity: Agent errors and hidden ASI scorer failures

`refactor/ts-rewrite` · base `79dbb19` · completed · 2026-10-04T21:40:00+08:00

## Goal

Treat Agent credential/quota errors and nested judge or scorer failures as `invalid`, not zeros
in the mean. Apply shared rules across adapters and distinguish execution timeouts from warnings.

## Changes

- `harness.agentErrorKind`: one rule set for "the Agent CLI could not work": credentials, quota
  (usage limit, insufficient_quota, credit balance), model unavailable, model unreachable.
- `sessions.runAgentFailure`: reads the in-run Agent home. Codex: the last `task_complete.error`;
  Claude Code: the last assistant reply with `isApiErrorMessage`. A later normal turn wins; earlier
  retried errors do not count.
- `bench/classify.ts` + `bench/service.ts`: such a failure makes the trial invalid (score kept,
  issue `Agent stopped: <kind> (...)`), for all adapters (Harbor, RCB, ASI, external).
- `bench/asi.ts`: `modelError` uses the shared rules, lets the final `turn.failed` win and ignores
  `Reconnecting...` notices; `scorerIssues` scans `gate_results` / `score_results`: judge
  `evaluator_unavailable` → invalid; `FileNotFoundError` / `No such file` → issue only.
- Design §7 outcome table; status.

## Decisions

- Agent errors are read from the Agent's own session, not from logs: the old "timed out" grep
  could mislabel successful runs. Orbit already keeps the in-run Agent home, so no adapter work is needed.
- A missing file in a scorer stays a note, not invalid: it may be the Agent's missing output.
- Not carried over: TB resource file (task.toml already declares resources), proxy relay
  (`--host-network` suffices), Codex version pinning (Orbit mounts the host CLI), old docs (kept in
  Git history).

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | 79dbb19 + this change (workspace) | passed | orbit 103 passed / 3 skipped, web 9 passed; biome, tsc, boundaries, builds |
| Unit tests (bench, sessions) | same | passed | rule set incl. negatives (`No module named`, model metadata warning), quota and retry order in `modelError`, hidden judge / file issues, classify invalid with kept score, Codex and Claude session endings |
| Real Codex error output (throwaway `CODEX_HOME`, invalid key) | same | passed | without proxy: `Reconnecting...` + connection reset; with proxy: final `turn.failed` 401 `invalid_api_key` and `task_complete.error` in the rollout; both shapes are what the rules read |
| ASI score report shape (ASI-Bench `38ab4b5`, `local_scoring.py`) | — | passed | items carry `gate_results` / `score_results` with `details.evaluator_unavailable` from `_judge_common.py` |
| A real bench trial ending in quota / auth failure | — | not_run | End-to-end failure scenario not exercised |
| Claude Code API-error transcript | — | not_run | an invalid key still succeeded (host login used); shape taken from the CLI's `isApiErrorMessage` field |

## Next / open issues

- Observe one real failing Agent trial end to end.
