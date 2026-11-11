# Bench adapter organization
branch: refactor/bench-adapter-organization · status: completed · updated: 2026-11-11

## Goal

Make adding a benchmark a local change instead of an edit to a shared 1,000-line file, let each
adapter directory carry its own contract, and close the gaps that let adapter and SDK code escape
every check in `pnpm verify`.

## Changes

**Product catalog**

- Split `bench/supported.ts` (1,125 lines, 39 inline entries) into one file per benchmark family
  under `bench/benchmarks/`. `shared.ts` holds the route/checked/group helpers and taxonomy presets;
  `index.ts` aggregates the entries and keeps the registration-family logic. Catalog output is
  byte-identical to the previous single file.

**Adapter directory contract**

- `test/adapter-directory-contract.test.ts`: every directory under `examples/bench-adapters/` needs
  an entry point, a README and tests, must be referenced by the product catalog, and the catalog
  must not point at a missing directory. One rule, no exceptions.
- Added the missing `humaneval` and `vla-eval` READMEs.
- Documented the contract in `docs/guides/bench-adapter.md` §0.
- `example-adapters.test.ts` discovers Python adapters by scanning the directory instead of a
  hand-maintained array, so a new adapter is covered without editing the test.

**Tests beside the code they test**

- The embodied adapter planning tests moved from `examples/sdk/orbit_embodied/` to
  `examples/bench-adapters/embodied/`. Nothing ran them in their old location.
- The WANDR score test moved out of `test/benchmark-gaps.test.ts` into
  `examples/bench-adapters/harbor-suites/wandr-score.test.ts` and imports `wandrScore` directly
  instead of reaching it through a `node -e` subprocess. The four remaining tests in
  `benchmark-gaps.test.ts` cover the core `harbor.ts` and `RunSpec`, so they stayed.
- `packages/orbit/vitest.config.ts` adds the adapter directories to the default patterns rather
  than replacing them; `tsconfig.examples.json` brings the adapter TypeScript into the type check.
  Neither `vitest` nor `tsc` looked at `examples/` before this.

**Service**

- Moved the pure submission checks (task selection, task existence, sample-plan agreement, trial
  slot expansion) out of `BenchService.submit` into `bench/submit-validation.ts`. Same checks, same
  order, same `UserError` messages; `submit` shrank from 167 to 121 lines.

**Repository hygiene**

- Added `examples/sdk/README.md`: what each SDK package is for, how to run the suite, and which
  optional package each failing group needs.
- Added `test/docs-links.test.ts`, guarding every relative markdown link in the navigation docs.
- Added `scripts/python-syntax.ts` to `pnpm check`, parsing all Python files with `ast.parse`
  (no imports, no bytecode).
- Cleared the lint backlog: the intentional compose interpolation fixtures are annotated, and the
  one real finding (a comma operator in the conversation search box) was rewritten.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Catalog output unchanged | `3d23a52` | passed | `supportedBenchmarks([])` byte-identical to the pre-split snapshot (39 entries). |
| `pnpm verify` | `bd85e0c` | passed | format, lint, types (incl. examples), boundaries, Python syntax, 746 tests (28 skipped), web 107, scripts 5, build. |
| Adapter contract test | `3f5810b` | passed | Found the two directories whose tests lived elsewhere; both were moved rather than exempted. |
| Python adapter run | `4388a22` | passed | Scanned discovery; every adapter directory with its own tests passes `unittest discover` standalone. |
| Moved embodied tests | `4388a22` | passed | 16 tests from the new location; previously unreachable by any runner. |
| Moved WANDR test | `4388a22` | passed | 1 test, now collected through the adapter directory patterns. |
| Docs links | `0fa9d83` | passed | 398 relative links across 136 navigation docs resolve; three dead links in the userns issue report were fixed (now `docs/guides/docker-userns-remap.md`). |
| Python syntax | `bd85e0c` | passed | 189 files parsed. |

Test counts reconcile across the moves: `benchmark-gaps` 6→5, `example-adapters` 24→25, new
`wandr-score` 1.

## Next / open issues

- `examples/sdk/` has 126 tests, but 44 of them need optional packages (`numpy`, `msgpack`,
  `websockets`, `pyzmq`, `openpi_client`). `pnpm verify` does not run this suite; the README
  documents the setup instead. A CI job with those packages would close the gap.
- Python dependencies are pinned per benchmark (`examples/bench-adapters/*/requirements-*.txt`)
  with no repository-level `pyproject.toml`, so there is no single install for the Python side.
  Introducing a linter or formatter was deferred: it needs network access this environment lacks.
- `service.ts` remains 1,626 lines. `BenchServiceDeps` is referenced 147 times, so splitting the
  class would cost more than it saves; further work should narrow that dependency bag rather than
  split the file.
- `embodied/` still holds 25 Dockerfiles and 48 Python modules in one directory. Splitting it by
  driver is unblocked by the contract test but not done here.
- One lint warning remains, an intentional compose fixture in `bench.test.ts`.
