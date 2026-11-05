# BFCL multi-turn category sample
branch: feat/sample-c3-bfcl · status: completed · updated: 2026-11-05

## Goal

Directly register BFCL multi-turn as C3 `tool-workflow` / `local-state`, with independent offline
upstream scoring and reproducible oracle/empty calibration.

## Changes

- External SDK adapter, isolated conversation driver and verifier, pinned BFCL package/data, image,
  data preparation helper and minimum-declaration README. Four original multi-turn categories.
- Original state/response checker scores freshly replayed calls; solve results/states/scores are
  untrusted. Reference self-check and explicit infrastructure failures prevent false valid zeros.
- The driver calls upstream tool methods directly to preserve exception types; the scorer remains
  unmodified. Infrastructure errors cannot be hidden by a simultaneous schema type mismatch.
- Explicit synthetic tests cover native parity, reset, schema errors, evidence tampering and faults.
- Preserve upstream acceptance of string ticket IDs despite integer schema hints. Keep the one
  reference that uses a held-out tool too early visible with an explicit unsupported reason.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Python unit tests with pinned upstream | final sample | passed | 20 tests, on host and in the real offline image; synthetic fixtures and explicit fault doubles. |
| Docker image build | working tree | passed | Pinned base/wheel, minimal local-tool dependencies. |
| `bench coverage` | working tree | passed | Four complete catalogs; 799/800 runnable, one inconsistent upstream reference unsupported. |
| `bench calibrate --sample 4 --seeds 2` | final sample | passed | `calibrated`; 16 valid trials, oracle 1 / empty 0, exact repeats, cleanup confirmed, 16/16 rescored unchanged. |
| Corpus compatibility probe | initial implementation | failed | Found overly strict schema typing and an unavailable-tool reference; corrected/declared above. |
| Full reference/empty corpus parity | final sample | passed | All 799 supported conversations match direct upstream checks in a real offline Orbit Run; all eight tool classes covered. |
| `pnpm verify` | final sample | passed | Format, lint, types, boundaries, tests and build. |
| Isolated daemon and labelled-resource cleanup | final sample | passed | Daemon stopped; zero containers/networks/volumes for its home; disposable home removed. |
| External model/API method | working tree | not_run | Not implemented; no model/API calls are authorized for validation. |

## Next / open issues

No blocking work remains. `multi_turn_miss_func_49` needs a corrected upstream reference before
support can be enabled. External model methods and API validation remain outside this sample.
