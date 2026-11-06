# WidowX catalog completion and GR00T reference controls
branch: feat/embodied-eval · status: completed · updated: 2026-11-06

## Goal

Complete the seven-task native SimplerEnv WidowX catalog and exercise pinned benchmark reference
functions with real GR00T under matched sampled conditions. Complete-suite statistical equivalence
remains a separate, unfinished study.

## Changes

- Complete the WidowX catalog with sink, open-drawer and close-drawer tasks, pinning their source
  dependencies. Existing jobs retain their frozen benchmark snapshots.
- Freeze ordered reset plans, model-stream boundaries, reference instrumentation and acceptance
  criteria before complete-suite execution. Keep plans, scores, logs and analysis outside Git.
- Use the OpenPI LIBERO evaluation loop with a GR00T transport boundary, and the NVIDIA WidowX
  evaluation loop with its native multistep wrapper. Record configuration changes explicitly.
  This compares the registered native protocols, not NVIDIA's published LIBERO scores.

## Validation

The planned arms each contain 500 LIBERO Spatial and 700 WidowX episodes. Require complete,
valid paired coverage with no result-based stopping or best-of retries. Predeclare a 5 percentage
point equivalence margin, a 90% interval for the paired difference and a 10 percentage point
per-task point-difference guard. Combine task-cluster resampling with a conservative simultaneous
interval for discordance probabilities; retain finite uncertainty when all observed pairs agree.
Report insufficient precision as inconclusive. Assumptions and exact sample identities stay with
the local frozen plan; this does not certify every model random stream or execution backend.

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Seven-task native WidowX preflight | 61f8263 + catalog update | passed | Every task initializes, renders and executes native controls |
| Initial reference metadata decoder | working tree | failed | Development harness incorrectly decoded an already-deserialized object; failed before inference; original evidence retained |
| Reference boundary controls | working tree | passed | Corrected harness completes both live two-episode paths; later-episode trace lengths differ, so this is not a bitwise-equivalence verdict |
| Paired analysis edge cases | local analysis harness | passed | Six explicit synthetic checks cover finite uncertainty, low power, invalid pairs, arm symmetry and task-regression guards |
| Python 3.8 / 3.11 SDK and protocol | working tree | passed | 53 checks each |
| pnpm verify | working tree | passed | 724 tests passed, 26 existing skips; lint, types, boundaries and builds passed |
| Complete paired suites | working tree | not_run | Incomplete cohort stopped after cost/scope feedback; evidence retained, no statistical-equivalence verdict |

## Next / open issues

The full cohort and detached monitor have been stopped after the integration cost review. Original
plans and evidence remain outside Git; all cohort Runs are terminal, cleanup is complete and leases
are released. Full-suite consistency remains unestablished. Routine onboarding follows bounded,
reusable endpoint and native-semantic checks; a complete statistical study needs its own scope and
compute budget. Keep sampled integration, suite coverage, statistical equivalence and independent
process bitwise repeatability as separate verdicts.
