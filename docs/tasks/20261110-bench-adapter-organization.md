# Bench adapter organization
branch: refactor/bench-adapter-organization · status: completed · updated: 2026-11-10

## Goal

Make adding a benchmark a local change instead of an edit to a shared 1,000-line file, and
let the adapter directory carry its own contract.

## Changes

- Split the product catalog into one file per benchmark family under `bench/benchmarks/`.
  `shared.ts` holds the route/checked/group helpers and taxonomy presets; `index.ts`
  aggregates the entries and keeps the registration-family logic. Catalog output is unchanged.
- Added `test/adapter-directory-contract.test.ts`: every adapter directory needs an entry point,
  a README and tests, must be referenced by the product catalog, and the catalog must not point
  at a missing directory. Tests kept with the shared code they exercise are declared in
  `TESTS_ELSEWHERE`, and the declared path itself is checked.
- `example-adapters.test.ts` now discovers Python adapters by scanning the directory instead of a
  hand-maintained array, so a new adapter is covered without editing the test.
- Added the missing `humaneval` and `vla-eval` READMEs.
- Documented the directory contract in `docs/guides/bench-adapter.md` §0.
- Moved the pure submission checks (task selection, task existence, sample-plan agreement, trial
  slot expansion) out of `BenchService.submit` into `bench/submit-validation.ts`. Same checks, same
  order, same `UserError` messages; `submit` shrank from 167 to 121 lines.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Catalog output unchanged | `3d23a52` | passed | `supportedBenchmarks([])` byte-identical to the pre-split snapshot (39 entries). |
| `pnpm verify` | `65844c2` | passed | format, lint, types, boundaries, 744 tests (28 skipped), build. |
| Adapter contract test | `3f5810b` | passed | Found the two adapter directories whose tests live elsewhere; resolved by declaring the real path, not by relaxing the check. |
| Python adapter run | `3f5810b` | passed | 24 scanned cases; every adapter directory with its own tests passes `unittest discover` standalone. |

## Next / open issues

- The repository has no CI job that runs `pnpm verify`; these checks ran locally.
- `service.ts` remains 1,626 lines. `BenchServiceDeps` is referenced 147 times, so splitting the
  class would cost more than it saves; further work should narrow that dependency bag rather than
  split the file.
- `embodied/` still holds 25 Dockerfiles and 48 Python modules in one directory. Splitting it by
  driver is unblocked by the contract test but not done here.
