# Submit native embodied evaluations from Web

branch: feat/embodied-eval · status: completed · updated: 2026-11-26

## Goal

Create and copy native policy jobs from the Web evaluation form using a frozen sample plan.

## Changes

- Evaluate accepts a prepared plan and registered policies. Copy and create preloads the source plan, batch size, and policy references.
- Web uses the existing policy registry and job submission endpoints. The daemon validates the frozen plan and policy compatibility.
- The Configurations step loads the current policy registry on entry and offers a manual refresh while it is open.
- Review shows the selected Policy's version and registration digest. Submission checks that digest against the execution snapshot. If the registration changed, refreshing policies keeps the evaluation draft for another review.
- Native evaluation review shows the per-sample timeout, including the effective timeout for a copied calibration.
- Copying configurations into an ordinary evaluation waits for the Agent registry, then imports the supported types and identifies any skipped configurations.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Browser submission with native LIBERO | working tree | passed | Imported two official samples, selected a registered policy, and submitted through the real daemon. Copy preserved plan order and batch size. |
| Browser submission errors | working tree | passed | The form displayed daemon errors for a changed plan digest and incompatible policy. |
| Copied policy availability | working tree | passed | The form reported a changed registry entry and required a replacement when the saved policy was removed. |
| Browser discovery of new policies | working tree | passed | Policies added from the CLI appeared on entering or returning to Configurations. Manual refresh while in Configurations preserved the draft and sample plan. |
| Browser review of updated policies | working tree | passed | A same-version registration update blocked submission for a new LIBERO evaluation and a copied policy calibration. Refresh and review preserved both drafts and saved the updated policy snapshot. |
| Browser review of timeouts | working tree | passed | LIBERO batch and calibration previews matched the submitted per-sample limits. |
| Browser copy of ordinary configurations | working tree | passed | A mixed HumanEval source copied its compatible configuration into ResearchClawBench and identified the skipped configuration. |
| Browser copy while Agents are loading | working tree | passed | An intentionally delayed or failed Agent request kept copying disabled. Loading or retrying preserved the draft, and the completed registry let a mixed source copy its compatible Agent. |
| Repository checks | working tree | passed | `pnpm verify` passed, including the new Web submission tests. |

## Next / open issues

Generate sample plans with the existing benchmark tooling. The browser check covered submission and deliberately reserved no GPU for episode execution.
