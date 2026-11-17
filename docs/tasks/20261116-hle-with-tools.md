# Public HLE with restricted tools
branch: feat/hle-with-tools · status: completed · updated: 2026-11-16

## Goal
Register available comparison-table adapters and add original public HLE with restricted code/web tools, independent grading and explicit protocol conditions.

## Changes
- Pin public data, question/image assets, answer index and original judge/filter/package sources.
- Run native Claude Code offline with a Unix-socket model relay and filtered search/fetch service; keep grading credentials and reference answers in the independent verifier.
- Preserve explicit offline CLI plans and translate an empty service-network selection to Docker network none.
- Add a product catalog family, setup documentation and regression coverage; original public HLE and HLE-Diamond remain distinct.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Python adapter/filter regressions | working tree | passed | 15 explicit synthetic fixtures; no mocked model or web result labelled real. |
| Core network/adapter integration | working tree | passed | Actual RunSpec and Docker arguments; explicit offline and omitted/default network cases. |
| `pnpm verify` | working tree | passed | 911 core, 136 Web and 5 script tests; types, boundaries and builds. 28 opt-in tests skipped. Independent Python test environment supplies existing embodied-test dependencies. |
| Real Docker isolation/web/cleanup | working tree | passed | Offline native CLI, read-only Unix socket, fixed packages, real filtered search/fetch, denied private/blocked URLs, no judge key/reference answer in Agent. Final service stop completed normally; cleanup confirmed and leases released. |
| Original-prompt alternate-judge controls | working tree | passed | Real empty/reference controls, native JSON-schema validation via explicit JSON-object transport; API schema-mode failure retained as invalid, never a zero. |
| Native text/image sample and rescore | working tree | passed | Real Claude Code text and image samples, independent original-prompt grading, saved-response identity and repeated text/control verdicts checked. |
| Full suite / HLE-Diamond / default judge | working tree | not_run | Public split and alternate judge only; no leaderboard or complete-suite equivalence claim. |

## Next / open issues
- Public HLE uses explicit model, judge, web backend and CLI conditions; HLE-Diamond is a different dataset/protocol.
- Upstream full-set denominator and calibration-error metrics are not implemented; Orbit reports valid-only sample accuracy.
- Other comparison-table data, credentials and protocol gaps remain in the availability matrix. Local registrations and personal test outputs are outside Git.
