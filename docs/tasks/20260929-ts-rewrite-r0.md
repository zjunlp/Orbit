# R0: TypeScript rewrite skeleton (Orbit)

`refactor/ts-rewrite` · base `f72c1d0576b6fe3008e1d8a639b468fa64976159` · completed · 2026-09-30T10:30:00+08:00

## Goal

Replace the Python v0 with a minimal TypeScript skeleton named Orbit. Acceptance: `pnpm verify` passes,
and `orbit resources` reports the real GPUs/CPU/memory of this machine.

## Changes

- Removed the Python implementation, old web, deploy, configs, and old docs; v0 remains at the local tag
  `v0-python-final`, which has not been pushed.
- New docs: `docs/design.md` (authoritative design), `docs/status.md`, a rewritten `AGENTS.md` (CLAUDE.md imports it), and a rewritten README.
- pnpm workspace with `packages/orbit`: contracts (zod), lib/exec, config (paths, daemon.json),
  resources/probe, daemon (Hono, token auth, `/api/v1/{health,resources,doctor}`), client, cli
  (commander, auto-start daemon), `src/bin.ts` composition root.
- `scripts/boundaries.ts` enforces the module dependency table; CI runs `pnpm verify`.

## Validation

| Check | Revision | Result | Evidence |
| --- | --- | --- | --- |
| `pnpm verify` | workspace before R0 commit | passed | biome, tsc, boundaries ok; 4 + 7 vitest tests; tsdown build |
| `orbit resources` / `doctor` (source and dist, temp `ORBIT_HOME`) | same | passed | GPU/CPU/memory discovery; Docker/driver checks; daemon auto-start and stop |
| CI on GitHub | — | not_run | branch not pushed |

## Next / open issues

- Push/PR/merge into `main` awaits the user's review.
- R1 per docs/design.md §9.
