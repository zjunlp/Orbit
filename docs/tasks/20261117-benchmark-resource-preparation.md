# Unified benchmark resource preparation
branch: feat/benchmark-resource-preparation · status: completed · updated: 2026-11-17

## Goal
Provide one CLI/Web entry for official-source download, existing-resource reuse, authorization guidance and validated registration for every supported benchmark family.

## Changes
- Add recipes for all 52 product families, with upstream sources, pinned revisions/checksums, preparation actions and explicit native/access prerequisites. Use the original adapters and configurators; preserve CUA-Lite collection identity.
- Add shared contracts and daemon API, `bench resources / prepare / preparation`, and a Web preparation form linked from every library entry. Show progress, cancellation, missing inputs and restored retry settings.
- Use existing process Runs, scheduler, Docker shim and cleanup; finish registration in the daemon only after cleanup. Validate all definitions before committing, preserve conflicting registrations, and record the result as a RunEvent for recovery.
- Keep downloads outside the installation, protect nonempty user directories, resume partial files, check reused inputs, and scope proxy/token passing to preparation.
- Bundle adapters, Python SDK and preparation helpers in npm; compile the external Harbor suites adapter. BFCL can extract a separately downloaded, hash-checked wheel.
- Document the workflow, prerequisites and distinction between preparation, runtime coverage and calibration.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | working tree | passed | 9 script, 943 core and 151 Web tests; 32 opt-in core tests skipped. Used the existing Python test environment with NumPy/websockets. Default host Python lacked websockets on the first attempt. |
| Preparation regression coverage | working tree | passed | All-family coverage; explicit local Git/HTTP fixtures for identity, checksum, cache/resume and gating; real daemon/process with explicit adapter fixture; existing registration protection and wrong-family refusal; Web access/reuse/status rendering. Fixtures do not validate official resources. |
| Installed npm package smoke | working tree | passed | Installed outside the repository; all 52 recipes exposed; bundled adapters/SDK/configurators, CLI, exports, daemon, Web and licenses checked. |
| Official HumanEval preparation and reuse | working tree | passed | Downloaded the pinned upstream source, listed all 164 tasks, registered and reused it without a second fetch. Caught and fixed the original data-subdirectory mismatch. |
| Real Docker development check | working tree | passed | One HumanEval problem with empty/oracle controls: valid 0/1, cleanup done for both. No model credentials or GPU jobs used. |
| Other recipes end to end / full-suite evaluations | working tree | not_run | Large, licensed or specialized native resources were not downloaded for this development check. Metadata/configurator paths were audited; missing native requirements stay explicit. |

## Next / open issues
- Build out automatic acquisition where an upstream still requires specialized native setup or a manually provisioned asset tree; each recipe links the original steps and accepts existing resources.
- Native container download helpers require a reachable container proxy when needed. Preparation does not alter evaluation network rules.
