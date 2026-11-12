# Positioning: the lab for self-improving agents
branch: docs/positioning-self-improving-lab · status: completed · updated: 2026-11-12

## Goal
Reposition Orbit as the lab for self-improving agents: it sits between the agent that decides and
the sandbox that isolates, and makes "was the work right" and "did the change help" checkable.
Keep the title "Learn and Evolve in Any Environment"; align subtitles and introductions with the positioning.

## Changes
- Title unchanged. New subtitles in both READMEs; design §1 explains how the title maps to the
  positioning (evolution needs evidence; many environments are how it is tested).
- Introductions describe four jobs (hands, evidence, acceptance, evolution gate) with a status column;
  capability tables name independent acceptance and versioned changes; the last roadmap row covers
  the gate and unified trajectories.
- Design §1 states the positioning and that the evolution gate design is not written there yet; the §9.16
  boundary ("no method-evolution claims") stays in force until a gate design is written there.
- No code, contract or behavior change.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| pnpm verify, first attempt | documentation working tree | failed | `example-adapters` embodied Python adapter check hit its 5 s timeout under host load; the file alone passed 25/25 |
| pnpm verify, full rerun | documentation working tree | passed | 752 Orbit, 114 Web and 5 script tests; 28 opt-in tests skipped; format, types, boundaries and builds passed |
| Claims against status.md and the CLI | documentation working tree | passed | Lineage options exist in `orbit bench run`; gate, unified trajectory format and transfer studies are marked as in design |
| Docker/GPU/Agent execution | — | not_run | Documentation only; runtime behavior unchanged |

## Next / open issues
- Design the evolution gate (task-set split, admission policy, margin-based non-regression) and
  revise §9.16 in the same change.
- The Chinese README still lacks the LongDS and native embodied rows of the English one.
