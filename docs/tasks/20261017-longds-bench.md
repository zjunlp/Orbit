# LongDS-Bench adapter
branch: feat/long-ds-bench · status: completed · updated: 2026-10-21

## Goal
Run DataMind's LongDS tasks through Orbit with the native sequential Agent sessions and original judge.

## Changes
- Added an external adapter/runtime for complete native Codex/Claude multi-turn tasks, exact dataset version/split selection and isolated original judging/rescoring.
- Saved task definitions and unmodified judge sources with solve evidence; strict scoring rejects partial turns and judge failures. Oracle is explicitly reference-answer replay calibration.
- Passed resolved solve resource overrides to adapters so native container limits match the lease; protected Orbit's Agent home from native runner defaults while retaining other environment overrides.
- Added setup/image instructions and explicit process-backend checkpoint/GPU limitations.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Upstream inspection | working tree | passed | Native Codex/Claude runners support one persistent task container and sequential native sessions; judging is separate |
| Adapter unit checks | working tree | passed | 12 tests with explicit filesystem/native-source fixtures; full-turn coverage, malformed/error scores, resource limits, ground-truth isolation and saved-source integrity |
| Full repository verification | working tree | passed | Format/types/boundaries/tests/build; 378 Orbit + 26 Web + 5 tooling tests; 14 opt-in Docker tests skipped, real shim check listed below |
| Original judge and rescore | working tree | passed | Real authorized judge API; blank/reference calibration, original output/aggregation parity, and rescore after staging removal; private experiment artifacts stay outside checkout |
| Real Docker shim and cancellation | working tree | passed | Auth/session home precedence, exclusion of grader-only variables, CPU/memory limits and labelled-child cleanup; no model calls in this check |
| Release Docker shim check | working tree | passed | Actual shim CLI and Docker: Agent-home precedence, runner effort override, session mount, CPU/memory limits, labels and confirmed cleanup; no credentials or model calls |
| Judge outage fixture | working tree | passed | Explicit HTTP 503 injection into the original judge yields invalid evaluation and no score |
| Native runner argument compatibility | working tree | passed | Original Codex and Claude dry runs accepted every generated flag and emitted every selected turn; no Docker/model calls, not Agent execution proof |
| Synthetic native Codex fixture | working tree | passed | Real authorized API and Docker, two sequential turns on one native session, future-question isolation, Orbit session capture and child cleanup; explicitly synthetic, not a LongDS task result |
| Complete native Agent task | working tree | passed | Real authorized Codex API and complete original task, one native session, actual analysis tools, requested model/effort, original per-task aggregation parity and confirmed cleanup; no benchmark score asserted |
| Complete task saved-answer rejudge | working tree | passed | All original turns rejudged with real API, same original aggregation, unchanged solve-file hashes, one solve Run and previous evaluation retained; staging/container already removed |
| Real Claude provider execution | working tree | not_run | Native flags/dry runs checked; real provider compatibility requires separate validation |

## Next / open issues
- Native process failure checkpoints and GPU allocation are unsupported; real Claude provider execution remains unchecked.
