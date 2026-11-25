# Prepare native LIBERO from its official repository

branch: feat/embodied-eval · status: completed · updated: 2026-11-24

## Goal

Prepare the base LIBERO benchmark independently of any model checkout using the same official
LIBERO revision as the existing simulator.

## Changes

- Pin the built-in preparation recipe to the official LIBERO checkout at `f78abd68`.
- Audit and build from separate LIBERO and OpenPI checkouts. Keep OpenPI's frozen dependency
  recipe, client and reference evaluator.
- Read the five suites' catalogs and initial states directly from the official checkout. Existing
  model-specific registration tools can still use their original source layout.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Native LIBERO catalog and SDK provisioning tests | working tree | passed | Direct and submodule layouts produce identical sample plans in the catalog fixture. |
| Official checkout and five suite catalogs | working tree | passed | Identical task records and sample plans for 130 tasks and 6,500 initial states. Registration rejected an incorrect source revision. |
| Packaged CLI preparation and native Docker runtime | working tree | passed | Prepared and registered with an uninitialized OpenPI submodule. Built the runtime using an existing dependency image with identical LIBERO requirements. Reset, rendered, and took a native control step in one task from each suite. |
| Fresh dependency image | working tree | failed | The new source copy and dependency resolution completed. The build was canceled during a slow package installation. |
| `pnpm verify` | working tree | passed | Formatting, types, boundaries, tests, and builds. |

## Next / open issues

- Independent model-specific preparation routes retain their current source layout. Registrations
  that use the shared native adapter need to be regenerated for its new implementation digest.
