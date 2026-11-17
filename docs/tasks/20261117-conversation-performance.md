# Long conversation review performance
branch: feat/conversation-performance · status: completed · updated: 2026-11-17

## Goal

Keep long Conversation reviews responsive while preserving search, failure/URL/keyboard navigation,
tool expansion and current-Trial content during slow reads.

## Changes

- Reuse TanStack Virtual for the turn directory and dynamically measured event rows, including one huge turn.
- Separate view indexing/filtering, virtual lists and event cards; index collapsed results once and retain expansion by stable event key.
- Abort related reads on refresh, identity changes and unmount; retain stale-response guards and hide previous-resource data immediately.
- Refresh the file listing, environment and linked session together; propagate cancellation through raw-file and aligned-environment consumers.
- Deterministic, contract-valid synthetic fixtures: 1,000 turns / 10,000 events and one turn / 5,000 events; no real experimental evidence.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Web regression | working tree | passed | 155 tests, including large-fixture mount bounds and cancellation propagation |
| Chromium interaction | working tree | passed | URL/history, h/l/e, failure jump, tool search/expansion, virtual remount and mobile; delayed reads on Trial switch; API/raw reads and uncooperative transport |
| Formal performance comparison and recording | final implementation | passed | Same Chromium 153.0.8010.12, viewport and host; five samples each; [measurements and reproduction](../guides/conversation-performance.md); separate real-browser recording with synthetic API data |
| Initial `pnpm verify` attempts | working tree | failed | Existing embodied adapter tests needed websockets/msgpack dependencies; no product or test logic changed |
| `pnpm verify` | final implementation | passed | Script 9, Orbit 931 (32 existing skips), Web 155; type/boundary checks and both builds pass. Existing PPT size warning only |

## Next / open issues

No required work remains. Full verification used a scoped `PYTHONPATH` containing the existing adapter's
`websockets==13.1`, `msgpack==1.1.0` and `msgpack-numpy==0.4.8`, installed outside the checkout.
Browser verification uses explicit synthetic responses; live daemon/production timing was not measured.
