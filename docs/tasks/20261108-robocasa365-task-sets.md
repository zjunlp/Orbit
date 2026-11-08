# RoboCasa365 multitask coverage

branch: feat/embodied-eval · status: completed · updated: 2026-11-08

## Goal

Expose the official 50-task multitask catalog through the native RoboCasa365 driver and keep
benchmark registration independent of model weights.

## Changes

- Read Atomic-Seen, Composite-Seen and Composite-Unseen and their task horizons from each pinned
  RoboCasa source. Keep separate task-set registrations and offer the upstream `target50` aggregate.
- Freeze the `pretrain` or `target` scene and object distribution in the sample-plan reference.
  Keep both legacy Atomic-Seen registration names and profile digests for `pretrain`.
- Add benchmark-only registration and keep the existing OpenPI and GR00T policy configurations.
  The 1.0.1 registry already includes the increased evaluation horizons used by GR00T N1.5.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Python registration tests | working tree | passed | Python 3.8 and 3.11 with synthetic registry data. Covers task grouping, scene identity, benchmark-only configuration and both legacy profile digests. |
| Pinned-source registrations and sample planning | working tree | passed | 18/16/16 tasks in the three groups, 50 unique in the aggregate. Both RoboCasa revisions and scene splits use the same task IDs and effective horizons. Adapter task listings and sample identity agree. |
| Published policy registration | working tree | passed | Composite-Seen with OpenPI and Composite-Unseen with GR00T both passed checkpoint and normalization audits. Their policy definitions exactly match the earlier Atomic-Seen definitions. |
| Native EGL task coverage and controls | working tree | passed | All 50 tasks reset, rendered and stepped on both pinned RoboCasa versions and both scene splits (200 cases). Representative tasks from both Composite groups matched direct native reset state, fixed control and success signals in all four configurations. |
| CPU OSMesa probe | working tree | failed | The first task exited during renderer initialization. The registrations use EGL. |
| New real-policy batches and full-suite statistics | working tree | not_run | The earlier Atomic-Seen real-policy checks remain applicable to that task set. |

## Next / open issues

- Orbit freezes independent first rollouts. OpenPI's reference advances a continuing reset stream
  per task and the GR00T reference uses vectorized environments. Full-suite score equivalence
  requires a separate comparison under matching sampling conditions.
