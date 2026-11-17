# Evolution baseline variants (V2)
branch: feat/evolution-baselines · status: completed · updated: 2026-11-17

## Goal
Provide no-change, bounded-note and published-method baselines using V1's existing evaluation path.

## Changes
- Add three orbit-evolve variants, fair comparison/A/A rules and a pinned official ACE source mapping.
- Ship a type-checked standalone JavaScript helper (directly executable inside npm installations): exact copy, cumulative append-only notes and incremental ACE ADD/counters; preserve parent and other bundle files.
- Package nested skill resources, exercise the installed helper and document method/budget/interpretation limits.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Construction regression | V2 tree, base e149247 | passed | Actual files, canonical Orbit digests, cumulative notes, incremental IDs/counters, budget failures and plain Node entrypoint |
| pnpm verify | V2 tree, base e149247 | passed | Format, lint, types (including standalone JS), boundaries, 1,147 tests and builds; 32 opt-in tests skipped; existing isolated Python dependencies |
| Installed package smoke | V2 tree, base e149247 | passed | Actual tarball installation outside checkout; exact nested skill bytes, executable helper, CLI/daemon/Web/assets/licenses; doctor prerequisites present |
| Real Codex variants | V2 tree, base e149247 | passed | Independent same-revision A/A; both edited candidates completed evolve smoke and frozen gate through existing operations; explicit reports and retained insufficient verdicts |
| Budget / persistence / cleanup | V2 tree | passed | New evaluation tokens within prospective cap, all task solves valid with confirmed cleanup, records unchanged after restart; private daemon stopped, no active labelled resources |
| Skill structure | V2 tree | passed | Shared skill validator; runtime behavior covered above |
| Claude checks | — | not_run | User requested no further Claude checks |

## Next / open issues
- V3 physical editor isolation is next; V4 powered comparisons remain separate. Bounded checks do not rank methods or establish benchmark improvement.
