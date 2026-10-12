# Consolidate completed benchmark retries
branch: fix/bench-consolidate → fix/consolidate-main · status: completed · updated: 2026-10-10

## Goal
Merge completed benchmark retries into the original task matrix and remove failed runs through the daemon.

## Changes
- Preview-first consolidation API, client, CLI and Web action; keeps target trial IDs and source run IDs/artifacts.
- Refuses active or unclean runs, mismatched methods/options/metrics and replacement of valid results (including zero scores).
- Atomic ownership update in Store; obsolete artifacts deleted by existing RunService. Invalid task outcomes remain visible.
- Optional invalid-history/artifact pruning; no image or download-cache deletion.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Targeted fixture tests | working tree | passed | Real daemon/API/store/filesystem; explicit terminal-run fixtures, not experiments |
| pnpm verify | working tree | passed | 185 Orbit tests passed, 10 opt-in tests skipped; 5 script and 11 Web tests passed; formatting, types, boundaries and build passed |
| Main integration: pnpm verify | af43081 | passed | 179 Orbit, 5 script and 11 Web tests passed; 10 opt-in tests skipped; formatting, types, boundaries and build passed |
| Built CLI command | af43081 | passed | `bench consolidate --help` exposes preview, apply and invalid-pruning options |

## Next / open issues
- Main integration contains only the consolidation feature, cherry-picked from 3555965 onto main; the Harbor changes in the original branch ancestry are excluded.
- Contract does not yet store immutable benchmark provenance; compatibility uses stored benchmark name, method, options and metrics. Caller must verify checkout identity.
