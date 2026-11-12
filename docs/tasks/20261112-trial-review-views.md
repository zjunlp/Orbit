# Trial page: tests and rubric views, grouped evidence, leaner header
branch: feat/trial-review-views · status: completed · updated: 2026-11-12

## Goal

Show every benchmark's trial through a small closed set of views chosen by the shape of its
evidence, not by benchmark name: six file views (markdown, image, video, text, json, table) and
six specialised ones (agent session, conversation, GUI trajectory, embodied episode, test report,
rubric). Add the missing test report view, complete the rubric view, trim the existing four, and
make the trial page shorter and easier to read.

## Changes

- **`tests` kind** (`contracts/bench.ts`, `lib/tests-report.ts`, `pages/trial/Tests.tsx`): reads a
  CTRF report as a checklist — failures first with message and trace, status filter, pass bar.
  Bounded (2000 tests, 20 000 characters per text); epoch seconds (pytest plugin) and milliseconds
  are told apart by magnitude; zero durations are not shown. A file named `ctrf.json` is read as a
  test report without a declared kind, so stored trials need no rescoring. Harbor declares it
  first as "Tests".
- **Rubric** (`pages/trial/Rubric.tsx`): `review.items` as rows with state icon, type, criterion,
  reasoning, score / max with a bar, weight; header counts per state and a "Lost points" filter.
  Adapters that already had per-item results now send them: ASI (gates and scorers), RLE-Bench
  (stages and checkpoints), AutomationBench (assertions), HumanEval (the unit-test check).
- **Tab plan** (`lib/review.ts` `reviewTabs`): replays and test reports get their own tabs first;
  Markdown reports and videos keep a tab only when there is no replay; every other file goes to one
  **Evidence** tab with a file list (`?tab=evidence&file=N`; an old `?tab=fN` link opens it there).
- **Header**: one result chip (state while running, invalid / unknown, completed or not for binary
  benchmarks); execution and cleanup chips only when abnormal; metrics that repeat the score or have
  no value are left out; timeline, resource use and earlier scorings sit under "Execution details",
  folded when a replay exists. Removed "Copy configuration" and the duplicate "Job" link.
- **Configuration and Details**: cards per section (Task / Agent / Policy / Environment), blank
  values left out, objects as nested rows instead of raw JSON.
- **Existing views**: one shared file bar (path, notes, Download) replaces per-view toolbars and
  footnotes; the Agent session tab drops its side panel; episode numbers print at four significant
  digits; unrecorded producer / trust chips are gone.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | branch head | passed | format, lint, types, boundaries, tests, build |
| Python adapter suites (rle-bench, automationbench, humaneval) | branch head | passed | `python3 -m unittest discover` in each directory |
| Trial pages in a real browser | branch head | passed | headless Chromium, GET only, against stored trials of each evidence shape: test report (passing, failing, invalid), judged report with rubric, conversation, GUI trajectory, embodied timeline and video, plain evidence files; Rubric, Evidence, Details, Configuration and Agent session tabs; dark and light themes. Found and fixed a class name collision that broke the checklist rows |
| New rubric items from the four adapters on a real trial | — | not_run | covered by unit tests only; stored trials show them after a rescore |

## Next / open issues

- Stored trials of the four adapters show the Rubric tab only after `orbit bench rescore`.
- Evidence still shown as raw JSON that could use an existing view: game logs as `conversation`,
  simulator episodes without a timeline index as `episode`.
