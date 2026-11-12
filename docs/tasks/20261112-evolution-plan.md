# Implementation plan: trajectories, export, fork and the evolution gate
branch: docs/evolution-roadmap · status: completed · updated: 2026-11-12

## Goal
Turn the agreed positioning into a plan that can be implemented and ticked off package by package:
unified trajectories, trajectory export, review and fork from a step, the evolution gate, a
reference evolver with baselines, and the cross-environment admission experiment.

## Changes
- `docs/evolution-plan.md`: 28 work packages in six groups (T trajectories, X export, F fork, E gate,
  V evolver and experiments, S support) with dependencies, modules, CLI/API surface and acceptance
  checks; a baseline of what exists today checked against the code; nine decisions; open questions and risks.
- `docs/research/trajectory/01-formats-export-fork.md`: dated survey of trajectory formats, converters,
  export targets and fork mechanisms, each claim marked as checked here, survey-only or inferred.
- Design §1, the docs map and status "Next" point to the plan. No contract or behavior change;
  design §9.8 and §9.16 are to be rewritten when T1 and E3 land.
- Two corrections to earlier verbal estimates, recorded in the plan: confirming a 5-point gain at 80%
  power needs about 290–580 paired tasks rather than 150–300, and a 2-point non-regression margin
  needs about 1800 tasks, so the proposed default margin is 5 points.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Baseline table against the code | documentation working tree | passed | Contracts, sessions, checkpoint, revision, metrics, hub, CLI options and routes read directly |
| Local CLI capabilities | documentation working tree | passed | Claude Code 2.1.319 and codex-cli 0.167.0 flags read from help text, the binary's option definitions and the generated app-server schema; behavior of truncating resume not exercised |
| Survey spot checks | documentation working tree | passed | Cited repositories and arXiv ids exist; Harbor adapters write ATIF v1.7; other survey claims are marked unverified |
| Sample-size table | documentation working tree | passed | Recomputed with the normal approximation stated in the plan |
| pnpm verify | bc8b4fe | passed | 752 Orbit, 114 Web and 5 script tests; 28 opt-in tests skipped; format, types, boundaries and builds passed |
| Docker/GPU/Agent execution | — | not_run | Documentation only |

## Next / open issues
- User decisions: default margin and alpha, whether "transferable" is only a level, ordering of the
  step-snapshot packages, which published methods to use as subjects.
- F0 (fork mechanism checks) and T1 (ATIF contract and converters) can start independently.
- The survey's original report and downloaded upstream files were lost with a host reboot; the
  research note was written from what had been read.
