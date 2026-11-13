# Native ATIF adoption
branch: feat/run-trajectory · status: completed · updated: 2026-11-13

## Goal
Implement T5's first on-demand package: adopt existing Harbor/Cua ATIF through the shared Run
trajectory lifecycle. Other T5 sources remain separate future packages.

## Changes
- Strict v1.5–v1.8 validation with source version/standard fields preserved and Orbit provenance added.
- Explicit RunSpec source, CLI import, remembered rebuild source and worker forwarding.
- Cua adapter automatically declares native ATIF; no JSON discovery heuristic.
- Local image/audio packaging with actual content hashes, bounded reads and source-root checks.
- Existing storage, backups, redaction, Session projection, token usage and environment views reused.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Targeted import/lifecycle/adapter checks | T5 working tree | passed | Real store/converters/handlers; scheduler and HTTP transport doubles explicit |
| Upstream interoperability | T5 working tree | passed | Actual Cua exporter and Harbor validator, including local PNG; synthetic rows, no model or desktop |
| pnpm verify | T5 working tree | passed | 853 core + 136 Web + 5 script tests; 28 opt-in tests skipped; format, types, boundaries and builds passed |
| Real container lifecycle | T5 working tree | passed | Offline Cua exporter; automatic persistence before API read, media saved, rebuild stable, cleanup done and lease released; no model/desktop |

## Next / open issues
- This package is kept on the existing branch; no merge or push is part of this task.
- dsh/pi and MobileWorld/OSWorld/AgentLab/vla-eval importers remain pending until needed.
- Remote media URLs must be collected locally before importing.
