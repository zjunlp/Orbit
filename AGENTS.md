# Orbit Agent Rules

Orbit runs experiments for Codex / Claude Code in isolated Docker containers under resource rules,
and records everything for local review. Keep it **simple and practical**: build what we actually use.

These rules apply to every change, including this file. `CLAUDE.md` imports this file; edit only `AGENTS.md`.

## 1. Before you start

1. Read this file, [docs/design.md](docs/design.md) and [docs/status.md](docs/status.md).
2. If resuming, read the task record in `docs/tasks/` and reconcile it with `git status`, `git log` and the diff.
   Do not trust a record or conversation memory over the actual files.
3. Identify the goal, the modules touched and how you will prove it works.

## 2. Git

- Never edit, commit or push on `main`. Work on a task branch (`feat/…`, `fix/…`, `docs/…`, `refactor/…`).
  Use a separate worktree beside the main checkout (`../infra-wt-<name>`) for concurrent tasks.
- Stage only files of your task; review the full staged diff before committing.
- Do not reset, clean, stash or overwrite work you did not create. Do not rewrite shared history or force-push `main`.
- Push, open PRs and merge only as the user has authorized.

## 3. Code

- Follow the module layout and dependency table in [docs/design.md §3](docs/design.md). `pnpm check` enforces it.
- The daemon is the only writer of local state. CLI, MCP and Web go through the HTTP API (`client/`).
- Shared data shapes live in `contracts/` as zod schemas. Change a contract → update daemon, client, CLI, Web and tests together.
- Extend existing modules before adding new ones. No second state machine, ledger, store or execution path.
- Execution outcome, cleanup status and evaluation validity stay separate fields. Release a lease only after cleanup is confirmed.
- Fakes and test doubles are explicit and never substitute for failing real integrations.
- Secrets, credentials, datasets, weights, runtime logs and run artifacts never enter Git or records.
- Real Docker/GPU checks touch only Orbit-labelled resources created by the task; never stop unrelated workloads.
- TypeScript only uses erasable syntax (no `enum`, no parameter properties) so Node can run `.ts` directly.
- Code, identifiers and code comments in English. Keep comments rare and useful.

## 4. Done means verified

- `pnpm verify` (format, lint, types, boundaries, tests, build) passes.
- Changes touching Docker, GPUs, auth or Agent CLIs also need a real check on this machine when feasible.
- Report every check honestly as `passed`, `failed` or `not_run` (with reason). Never report a fake-backed check as real.

## 5. Records (keep them short)

| File | Purpose | Rule |
| --- | --- | --- |
| `docs/design.md` | Architecture, contracts, decisions | Update in the same branch when a boundary, contract or decision changes |
| `docs/status.md` | What works now, gaps, next steps | ≤ 40 lines; replace outdated text, never append history |
| `docs/tasks/<YYYYMMDD-slug>.md` | One per feature, substantive fix or design change | Use the template below; small fixes need only a good commit message |
| `docs/guides/` | How to use a feature | Only for implemented behavior |

Source-controlled records describe reusable product behavior, design decisions, bugs and development
validation. Keep personal experiment results, batch progress, scores, retry/consolidation histories,
private resource configurations and account or machine inventories outside the source checkout in
user-owned notes. Do not copy them into task records, commit messages or PR descriptions. Mixed
records must retain only the reusable technical content. Disposable test fixtures and reproducible
development checks may be documented, with fakes and untested behavior identified honestly.

Task record template:

```markdown
# <title>
branch: <branch> · status: in_progress | blocked | completed · updated: <ISO date>

## Goal
## Changes
## Validation
| Check | Revision | Result | Notes |
## Next / open issues
```

## 6. Handoff

Report what changed, what was verified (and what was not), the branch/commit, and the next step.
Communicate with the user in their language (Chinese by default).
