# Web page layout and visual consistency
branch: feat/web-polish · status: completed · updated: 2026-11-12

## Goal

Make the Web pages read as one product: the same page frame, title block, controls and status styles
everywhere, without changing what each page shows.

## Changes

- `components/PageHeader.tsx`: title plus one-line description; used by Evaluations, Agents,
  Configurations, Resources and Settings (Overview and Benchmarks keep their own headers). The job
  page shows the job name as its title.
- Page frame: `.page-pad` is centred with `--content-max` (1600px) and more breathing room; Settings
  uses the same width as other pages. Crumbs say "Evaluations" everywhere (was "Bench").
- Sidebar footer: Settings, then one row with the connection state (Live / Offline / Connecting)
  and icon buttons for shortcuts, theme and collapse, with tooltips; collapsed and narrow layouts stack them.
- Controls: the Agents view switch is an underlined `subtabs` bar with counts; job state is a
  coloured badge (running pulses); primary buttons use a stronger blue; `<progress>` bars are slim
  and themed; collapsible cards (`details.card`) show a chevron and drop the header rule when
  closed; the trial page's "Execution details" uses the same disclosure caret.
- Tables: headers inside cards match the card surface; the Evaluations results column wraps and is
  titled "Results by configuration" (the full meaning moved into its tooltip).

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | branch head | passed | orbit 752 passed / 28 skipped, web 114 passed |
| Visual check in a real browser | branch head | passed | headless Chromium against the local daemon's data: Evaluations, job, GUI and conversation trials, Agents, Resources, Settings; dark and light themes; 1440 px and 820 px wide |
| Pages not re-checked by screenshot | — | not_run | New evaluation form, Compare pages and Run detail tabs: only the shared styles changed there |

## Next / open issues

- Catalog filter memoization, aborting stale `useAsync` requests and conversation virtualization (performance, not layout).
