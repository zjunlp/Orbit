# Native embodied adapter directory layout

branch: feat/embodied-eval · status: completed · updated: 2026-11-11

## Goal

Make benchmark setup and model service files discoverable by family within the shared native adapter.

## Changes

- Group setup, simulator recipes, asset preparation and guides in `benchmarks/`. Group model images,
  services and checkpoint tools in `policies/`. Keep renderer configuration in `runtime/`.
- Update the catalog links, CLI examples, Docker build inputs and test paths. Keep the root
  registration, planning and execution paths and the frozen implementation digest.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Workspace and SDK regressions | working tree | passed | `pnpm verify` and both documented SDK environments. |
| Setup paths | working tree | passed | 29 host CLI help commands, local Docker inputs and adapter guide links. |
| LIBERO-PRO image and registration | working tree | passed | Built the relocated recipe, matched 20 conditions and 200 entries against the previous profiles, and ran three native preparation tests. |
| Historical LIBERO-PRO rescore | working tree | passed | Re-scored a saved episode through an isolated daemon with the same valid outcome. |
| GR00T image | working tree | passed | Built from the relocated policy recipe and ran the service help command inside the image. |
| Other native builds and model rollouts | working tree | not_run | Coverage for the remaining recipes is limited to path and host checks. |
