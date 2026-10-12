# R1: single-node research loop

`refactor/ts-rewrite` · base `80bfe39` (R0) · completed · 2026-09-30T11:50:00+08:00

## Goal

Acceptance (design §10): Codex estimates resources and submits a 3-seed GPU sweep; runs queue; `orbit wait`
works; failures keep their evidence; the Web UI shows the diff, curves, logs and linked session; both Codex and
Claude Code work end to end. The user also asked for a polished, practical review UI modelled on
sandbox and experiment-tracking products.

## Changes

- Run lifecycle (commit `5923fdb`): sqlite store, allocator and leases with a queue, code snapshot, Docker
  executor (CDI GPUs, host user, `/orbit` records mount), records (logs, metrics, artifacts, events),
  session parsing for Claude Code and Codex, and the CLI (`run`, `sweep`, `ps`, `show`, `logs`, `wait`,
  `cancel`, `note`, `web`).
- `packages/web` Web UI: runs, run detail, compare, resources. React + Vite + uPlot, contracts imported as
  types only.
  - Design references: W&B/Neptune compare, Modal/E2B run detail, GitHub diff.
  - Built into `packages/orbit/dist/web` (`scripts/copy-web.ts`) and served by the daemon.
- Daemon changes:
  - `GET /runs/:id/log.txt`.
  - `/login?next=` redirect, restricted to in-site paths.
  - `orbit web <id>` opens the run directly.
- `orbit wait -g <group>`.
- Agent detection: when agents are nested, the nearest `claude`/`codex` ancestor process decides the harness,
  because Codex started from Claude Code inherited `CLAUDECODE` and was mislabelled.
- Codex transcripts: the JS `exec` tool of Codex 0.158 is shown as its shell commands, and its results
  are unwrapped.
- `scripts/boundaries.ts` now also checks `packages/web/src`: imports stay local, and anything from Orbit
  must be a type-only import from contracts.
- Plugin:
  - `plugin/skills/orbit/SKILL.md` covers resource estimation, submit, wait, inspect and notes.
  - `plugin/.claude-plugin/plugin.json` and the root `.claude-plugin/marketplace.json`.
  - `plugin/README.md` gives install notes.
- Docs: `design.md` (container, session, API and Web sections), `status.md`, README.

## Validation

Development checks used Docker with CDI and a throwaway daemon: `ORBIT_HOME=/tmp/orbit-r1/home`, `ORBIT_PORT=7791`, demo git repo with uncommitted changes.

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | working tree on `5923fdb`, before the R1 web commit | passed | Biome, tsc, boundaries (orbit + web); tests: root 5, orbit 27 + 3 skipped, web 6; build |
| `ORBIT_E2E=1 ORBIT_E2E_GPUS=1 vitest run test/e2e.docker.test.ts` | same | passed | 3 tests with real Docker and GPU; no `orbit.run` containers left |
| Codex e2e: `codex exec` (0.158.0) with the skill, 3-seed GPU sweep | same | passed | Codex read SKILL.md and ran `orbit resources`. It chose 1 GPU, 0.1 GB GPU memory, 1 CPU, 0.25 GB RAM and a 5 min timeout, then ran `orbit sweep -g codex-sweep`, `orbit wait -g`, logs and notes. All 3 runs succeeded and are linked to the Codex thread. The runs were launched with `-s danger-full-access`, because the workspace-write sandbox blocks the daemon's localhost HTTP |
| Codex e2e, first attempt | before the detection fix | failed | Runs were labelled `claude-code` because the nested agent inherited the env vars. Fixed and re-run as above |
| Claude Code e2e: disposable parameter and multi-GPU sweeps | same | passed | Runs queued beyond 4 GPUs, `orbit wait` worked, and the runs link to the Claude Code session. Claude Code used the CLI directly, not the plugin |
| Failure evidence: `crash-test` (exit 3), `lr3e-4` (argparse exit 2) | same | passed | Logs with the traceback, metrics up to the failure, and cleanup done |
| Web review: CDP screenshots of every page, dark and light | same | passed | No console errors. Checked the diff, curves, logs, session (Claude Code and Codex, with the submit marker), compare with seed aggregation, and resources with live leases and queue |
| `claude plugin validate` for the repo and `plugin/` | same | passed | `claude plugin install` itself: not_run |
| CI on GitHub | — | not_run | branch not pushed |

## Next / open issues

- Push, PR and merge await the user's review.
- Codex in its default sandbox cannot reach the daemon. Users need network access for `orbit`, or a sandbox rule allowing 127.0.0.1.
- R2: auth profiles, notifications, MCP.
