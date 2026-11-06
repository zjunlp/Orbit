# Preserve legacy acceptance budgets during rescore upgrade
branch: feat/embodied-eval · status: completed · updated: 2026-11-06

## Goal

Upgrade completed policy checks without counting later manual CPU rescore against their original
execution budget or cancelling a manual verifier already in progress.

## Changes

Recover the original execution boundary from retained initial scorings and the first selected
automatic rescore. Require the original solve/verify evidence to have ended and only exclude CPU
verification created after that boundary. Old premature completion markers cannot hide unfinished
original work. Freeze legacy completion before mutating Trial history for a new manual rescore;
reuse existing history, Run ownership and the execution timestamp without another state store.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Baseline migration regressions | fc41dab | failed | Five synthetic cases reproduce retroactive timeout or cancellation: first/other sample, finished/active manual verification and automatic rescore disabled |
| Focused lifecycle regressions | working tree | passed | 75 tests, including the five migration cases and original planning-expiry controls; explicit synthetic adapter/Run replies |
| `pnpm verify` | working tree | passed | 752 tests passed, 26 existing skips; format, lint, types, boundaries and builds passed |
| Real Docker upgrade after completed manual rescore | working tree | passed | Pinned c19ace2 service/report logic generates original acceptance and late manual CPU verification; current recovery restores the original budget without retroactive timeout |
| Real Docker upgrade during active manual rescore | working tree | passed | Running container and active lease survive recovery without cancel intent; original budget remains fixed, manual verification completes, all ten owning Runs across both cases cleaned and leases released |

## Next / open issues

The real Docker checks use explicit synthetic CPU model/adapter fixtures and real containers,
recovery, leases and cleanup. No VLA inference or full-suite model statistics are claimed.
