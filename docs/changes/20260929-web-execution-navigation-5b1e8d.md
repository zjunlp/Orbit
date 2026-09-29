---
record_version: 1
task_id: "20260929-web-execution-navigation-5b1e8d"
title: "Keep research execution navigation under research projects"
branch: "fix/web-execution-navigation-20260929"
base_commit: "f72c1d0576b6fe3008e1d8a639b468fa64976159"
work_status: completed
updated_at: "2026-09-29T16:28:00+08:00"
pull_request: null
---

## Goal and acceptance

- Correct the Settings highlight on `#execution/<run>`: research Run lists and details belong to Research Projects, including direct links, refreshes and return navigation.
- Keep the page title and content correct and preserve existing URLs. Move the Run list entry into the research project page.
- Validate frontend checks/build and browser navigation without calling models, Docker or changing real experiment records.

## Changes

- Secondary pages declare their title and parent section explicitly in `src/web/src/app.tsx`. `runs` and `execution` belong to Research Projects; the page title remains Research Runs. Highlight and `aria-current` use the same parent selection.
- Moved the Run list shortcut from Settings to the research project page. Existing detail URLs and the return-to-runs link remain unchanged.
- Updated both Web operation guides. The project overview is unchanged because this is a navigation correction, not a capability or milestone change.

## Decisions

- Correct the navigation ownership introduced by the [workbench redesign](20260928-web-workbench-usability-9a2c6e.md); do not infer parent navigation merely from being a secondary page.
- Keep the current four primary entries. No backend/API/data migration; no project-level status change.

## Validation

| Check or command | Tested revision or snapshot | Result | Evidence or limitation |
| --- | --- | --- | --- |
| Repository and route inspection | f72c1d0 | passed | Clean main. All secondary routes were assigned the Settings highlight regardless of function. |
| `pnpm check` and `pnpm build` | Source snapshot S1 | passed | Biome/TypeScript and production build passed; 44 checked files, JS asset `index-BIZg9QQv.js`. |
| `node /tmp/infra-execution-navigation-browser.cjs` | S1, temporary workflow fixture | passed | Project shortcut → Run list → execution, reload/direct route, return/back, page title, unique highlight and accessibility state; Settings/Agent/Records/Benchmark remain correctly selected; no overflow at 390px. An initial check compared text including the decorative icon; corrected the check to use the accessible link name. No product code change was needed for that check. |
| `node tests/web/workflow.smoke.cjs` with existing local Playwright/Chromium | S1 | passed | Existing initialization/binding/compile/preflight/submit/reload/cancel/results/analysis/mobile workflow. Explicit fake execution backend; no model or Docker. |
| Read-only `GET http://127.0.0.1:8765/` | S1 build | passed | Served HTML exactly matches rebuilt `src/web/dist/index.html`; no service restart or experiment data mutation. |
| `uv run --locked python scripts/ci/check_repository.py`, `git diff --check`, final diff review | Task workspace | passed | Local documentation links/policy mirrors and whitespace passed; only task-related source/docs changes. |
| Backend suite and real model/container execution | None | not_run | Frontend-only correction; no backend contracts or runtime data changed. |

S1: SHA-256 `c7f19444a1915967e10d78f81f4912efc2c65c12d25d38901d4b3ea072ec2367` of `git diff f72c1d0 <task-commit> -- src/web/src/app.tsx src/web/src/features/projects.tsx`.
Local logs: `/tmp/infra-execution-navigation-{check,build,browser,workflow}.log`; browser screenshot: `/tmp/infra-execution-navigation-20260929.png`. Browser tools reused the existing external Playwright/Chromium installation; no dependency changes.

## Open items and blockers

- None within the navigation correction scope.

## Next steps

- Reload the existing Web page to use the rebuilt assets. Task-branch integration remains separate from implementation completion.

## Compatibility and rollback

- Preserve `#execution`, `#runs` and other existing links; only navigation ownership and entry placement change. Revert the change and rebuild assets to roll back.
