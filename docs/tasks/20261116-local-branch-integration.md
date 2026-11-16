# Integrate local feature branches
branch: feat/run-trajectory · status: completed · updated: 2026-11-16

## Goal
Combine completed local commits into main and publish the verified integration to origin.

## Changes
- Integrate feat/run-trajectory (10ef9ce), fix/benchmark-taxonomy-evidence (b832f62), feat/behavior-robotagent-bench (f6937ac) and the HLE commit already on main (d8c036a).
- Retain audited catalog profiles alongside navigation integrations, with one entry per family; reconcile catalog counts and current documentation.
- Port BEHAVIOR validation, per-episode process requirements, native scoring and resource settings into the refactored shared-reference adapter; preserve existing navigation and LIBERO-Mem behavior.
- Extend the controlled BEHAVIOR contract check to reject incompatible action grouping and connectors before staging.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Merge reconciliation | integrated tree | passed | No conflict markers; catalog has 52 unique families; source branch commits retained |
| pnpm verify | integrated tree | passed | Format/lint, types, boundaries, 9 script, 931 core and 149 Web tests, both builds; 32 opt-in core tests skipped |
| Real Docker ending phases | integrated tree | passed | 6 tests: restart recovery, cancellation, deadline handling, evidence collection, service shutdown and cleanup; task-owned CPU-only containers |
| New native model/GPU/Claude checks | integrated tree | not_run | Merge task; existing check records remain scoped; BEHAVIOR/RobotAgentBench native preparation and calibration remain deferred |

## Next / open issues
- Native BEHAVIOR/RobotAgentBench preparation and calibration remain deferred as recorded in their feature task.
- Source branches remain available for continued work after integration into main.
