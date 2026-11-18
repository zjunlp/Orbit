# Orbit agent plugins

Three shared skills cover experiment execution/review, benchmark integration and configuration evolution.
Every host calls the same Orbit CLI; the skills fall back to `npx -y @zjunlp/orbit` when `orbit` is
not on PATH. Requires Linux and Node.js 24.18+ (24.x); experiments also need Git and Docker.

## Install

With your agent CLI already installed, choose one command:

```bash
npx -y @zjunlp/orbit plugin install claude
npx -y @zjunlp/orbit plugin install codex
npx -y @zjunlp/orbit plugin install dsh --profile headless
npx -y @zjunlp/orbit plugin install pi
```

Omitting the agent defaults to Claude Code. Restart the agent after installation. Repeating the
command uses its native installer and does not duplicate the registration.

| Host | Native integration | Skill names |
| --- | --- | --- |
| Claude Code | User plugin `orbit@orbit` from `zjunlp/Orbit` | `/orbit:orbit`, `/orbit:orbit-bench`, `/orbit:orbit-evolve` |
| Codex | Plugin `orbit@orbit` from the repository marketplace | `orbit:orbit`, `orbit:orbit-bench`, `orbit:orbit-evolve` |
| DeepSeek Harness (`dsh`) | npm bundle in the explicitly selected profile | `orbit`, `orbit-bench`, `orbit-evolve` |
| pi coding agent | User npm package declaring `pi.skills` | `/skill:orbit`, `/skill:orbit-bench`, `/skill:orbit-evolve` |

Tested with Claude Code 2.1.289, Codex 0.161.0, dsh 0.1.6-alpha.1 and pi 1.1.0
(`@earendil-works/pi-coding-agent`). Older CLIs may need upgrading to expose the native commands.
dsh additionally needs a working **pnpm** on PATH and a profile with the skills service (the
`dsh-base` profiles such as `headless`, `sdk`, `web` or `acp`). `desktop` is reserved by dsh;
`sdk-minimal` omits skills and is rejected. For custom profiles, include `dsh-base`.

dsh and pi install the npm version matching the Orbit CLI running the command. Their registrations
refer to installed packages, never the temporary npx cache. Claude and Codex fetch the project
marketplace on GitHub; this does not list Orbit in an official curated marketplace.

## Local development

`--source` means a marketplace checkout/repository for Claude and Codex, and an npm package or
local package for dsh and pi. From this repository:

```bash
pnpm orbit plugin install claude --source .
pnpm orbit plugin install codex --source .
pnpm pack:release
pnpm orbit plugin install dsh --profile headless --source ./dist/zjunlp-orbit-0.2.0.tgz
pnpm orbit plugin install pi --source ./packages/orbit
```

pi's local source must be a built package **directory** that remains on disk; it registers that
path. To check the exact release artifact, unpack the tarball and point pi at the extracted
`package/` directory. dsh copies local sources into its profile through pnpm's `file:` protocol.

The `orbit-evolve` skill includes baseline variants (no-change, bounded notes, ACE), a deterministic
Node helper, and a minimal instruction bundle under its `assets/` directory. It uses the existing
export, gate-plan and verdict commands. The host can edit candidates directly or use the
[isolated Codex editor](skills/orbit-evolve/references/isolated.md), which receives only a copied
parent and evolve evidence. No daemon evolution loop is installed.

All skills are authored under `plugin/skills/`; the build copies them into `dist/plugin/skills`.
The dsh adapter only delegates to the host's filesystem skill provider. No dsh or pi runtime is
bundled into Orbit.

## Native management

The wrapper delegates to these commands (use the version you intend to install for npm packages):

```bash
claude plugin marketplace add zjunlp/Orbit
claude plugin install orbit@orbit --scope user
codex plugin marketplace add zjunlp/Orbit
codex plugin add orbit@orbit
dsh plugin --profile headless add @zjunlp/orbit@0.2.0
pi install npm:@zjunlp/orbit@0.2.0
```

For updates, use `claude plugin marketplace update orbit` then `claude plugin update orbit@orbit`;
for Codex, `codex plugin marketplace upgrade orbit` then `codex plugin add orbit@orbit`.
For dsh and pi, rerun the one-command installer with `npx -y @zjunlp/orbit@latest`.

Uninstall through the host that owns the registration:

```bash
claude plugin uninstall orbit@orbit
codex plugin remove orbit@orbit
dsh plugin --profile headless remove @zjunlp/orbit
pi remove npm:@zjunlp/orbit@0.2.0
```

For pi local installs, pass the same local directory to `pi remove`. Marketplace removal is
separate: `claude plugin marketplace remove orbit` or `codex plugin marketplace remove orbit`.
Existing manual copies/symlinks in agent skill directories should be removed when switching to
plugins to avoid duplicate skill names.

## Scope

The CLI needs permission to reach the local daemon at `127.0.0.1`; for a Codex workspace sandbox,
enable `sandbox_workspace_write.network_access` when submitting experiments.
Session capture and agents running inside containers currently support **Codex and Claude Code**.
dsh and pi can submit ordinary runs from the host using these skills; their session capture and
in-container auth/harnesses are not implemented. MCP is also still a separate gap.
