# Real GR00T fixed-batch validation
branch: feat/embodied-eval · status: completed · updated: 2026-11-06

## Goal

Validate fixed sequential batches with the pinned GR00T N1.7 model on native LIBERO and
SimplerEnv WidowX, using two different initial states per batch.

## Changes

Use the existing independent policy registrations, native adapters and batch execution path.
Keep generated plans, service observations, logs and episode results outside the source checkout.
Clarify in the GR00T guide that model startup and Torch initialization happen per solve Run;
fixed batches reset episode state while preserving the declared service random stream.
No production implementation changes were needed.

## Validation

Declare acceptance before execution: each pair must share one solve Run, model service and lease;
both episodes must independently verify, regardless of task success. Check episode-local reset
and control counters, frozen membership, a single model startup, CPU-only selected rescore,
unchanged evidence and the other Trial, report revision and final resource cleanup.

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Real GR00T / LIBERO batch | 61f8263 | passed | Two initial states, one shared solve/model process, no service restart, independent CPU verification |
| Real GR00T / WidowX batch | 61f8263 | passed | Two generated scene resets, one shared solve/model process; simulator and policy share the owning GPU role |
| Episode isolation and selected rescore | 61f8263 | passed | Control/chunk counters restart per episode; frozen sample/attempt identities verified; rescore preserves the other Trial, shared solve and evidence; report revision retains episode references |
| Initial WidowX proprioception-only reset assertion | 61f8263 | failed | Invalid development check: the native visual-matching recipe fixes robot pose while varying object placement; the original failed check is retained locally |
| WidowX native reset inspection | 61f8263 | passed | Audited the pinned reset recipe and inspected distinct object placements in both saved first frames; corrected the development check without changing product behavior |
| Resource cleanup | 61f8263 | passed | Solve and CPU verifier leases released; no task containers, networks or volumes remain |
| pnpm verify | 61f8263 + documentation | passed | 724 tests passed, 26 existing skips; lint, types, boundaries and builds passed |

## Next / open issues

These are sampled integration checks. Full-suite throughput, statistical equivalence and
independent-process bitwise repeatability require separate validation.
