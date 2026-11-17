# Gate workflow helpers (E4)
branch: feat/gate-workflow · status: completed · updated: 2026-11-16

## Goal
Plan missing frozen evaluations and inspect candidate bundles before exposing held-out evaluations.

## Changes
- Share E3 evidence resolution and E2 prerequisite checks in a read-only plan endpoint/CLI; preserve ambiguity and pending work.
- Generate guarded CLI commands from saved execution templates, with task-file hashes and transient expected method revisions checked before job creation.
- Share bounded bundle hashing and credential patterns with existing modules; inspect held-out IDs and optional reference SHA-256 values without echoing credentials.
- Document cost ordering in the shipped orbit skill; retain explicit gaps for unknown/encoded leakage, absent reference hashes and unavailable plan inputs.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| E4 regression | E4 tree, base dee64d0 | passed | 14 tests: real SQLite and HTTP handlers/client with synthetic reports; guarded submissions, read-only planning and bounded bundle inspection |
| pnpm verify | E4 tree, base dee64d0 | passed | Format, lint, types, boundaries, 1,103 tests and both builds; 32 integration tests skipped by configuration |
| Actual daemon and CLI | E4 tree, base dee64d0 | passed | Real local HTTP and CLI processes using synthetic saved reports; plan/check-bundle exits 0/2, credential redaction, legacy JSON and no new jobs/Runs/verdicts |
| Real model/GPU/Claude execution | E4 tree, base dee64d0 | not_run | Read-only workflow change; no Agent launch needed; further Claude checks omitted as requested |

## Next / open issues
- V0 pilot and V1 reference evolver remain separate work packages.
- Missing frozen sample-plan inputs or conflicting templates block command suggestions. Static preflight cannot certify unknown/encoded leakage; absent reference hashes remain not_run.
