# Native episode timelines and TextArena game conversations
branch: feat/trial-evidence-shapes · status: completed · updated: 2026-11-12

## Goal

Connect RoboDojo/RoboLab saved episodes and TextArena game records to the existing trial review
views, with bounded previews and honest handling of missing historical evidence.

## Changes

- Native verifier indexes RoboDojo/RoboLab actions, named state channels, chunks and recorded video.
  Uses each environment's recording rate; compact JSON and bounded sampling keep previews under
  2 MiB without rewriting raw evidence or changing the verdict.
- Episode view supports individual channels, long chunk summaries and a slowest-chunk jump;
  hides the Agent section when no session is linked and sizes chart axes to their tick labels.
- Harbor stages a guarded TextArena game recorder in the service and imports its observations
  and actions into the existing conversation shape. Original verifier rewards remain authoritative;
  missing or malformed records only affect the optional view. Raw service logs remain available.
- Existing TextArena logs contain startup messages only. Shared-mode trials cannot be rescored;
  those games must be rerun to capture moves. RoboDojo/RoboLab can generate indexes by rescoring
  their saved evidence, without rerunning the policy or simulator.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Web episode tests and typecheck | working tree | passed | Synthetic fixtures; includes median calculation and sampled chunk labels |
| Focused embodied SDK and adapter tests | working tree | passed | 70 SDK tests and 17 adapter tests passed; one optional official-source check skipped because its checkout was not configured; simulator test doubles are explicit |
| TextArena and related Harbor tests | working tree | passed | 69 tests; recorder behavior uses an explicitly synthetic Python server; older records without services/binds remain supported |
| `pnpm verify` | working tree | passed | Format, lint, types, boundaries, Python syntax, tests and build; existing oversized presentation-file warning remains |
| Real saved-episode verification | working tree | passed | Actual RoboDojo/RoboLab CPU verifier images via isolated Orbit runs; saved evidence read-only; valid indexes below 2 MiB; original verdicts unchanged; cleanup done |
| Episode browser review | working tree | passed | Real saved video with newly generated indexes via GET-only browser overlay; channel selection, seeking, slowest chunk, small numeric ticks; light/dark desktop and 390px viewport |
| Real TextArena recording | working tree | passed | Disposable GuessTheNumber oracle and empty trials through Harbor/Orbit; original expected rewards retained, conversations generated, cleanup done |
| TextArena browser review | working tree | passed | Actual new trial pages; recorded moves, empty-game truncation, search, source explanation; light desktop and dark 390px viewport |
| New GPU simulator / Policy rollout | — | not_run | This change imports saved evidence; CPU verifier and existing-video checks cover the changed path |

## Next / open issues

- Ready for user review; branch remains unmerged.
- Historical TextArena games without move records require a rerun; other server variants remain raw-log only until supported.
