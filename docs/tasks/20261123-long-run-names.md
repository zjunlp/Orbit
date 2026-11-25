# Long Run display names

branch: feat/embodied-eval · status: completed · updated: 2026-11-23

## Goal

Create benchmark Runs when an upstream task ID contains a long instruction.

## Changes

- Use a shared 512-character limit for Run names and generated name fitting.
- Preserve the method, sample label, and phase when shortening a benchmark display name.
- Fit smoke, resume, and benchmark preparation names with the same helper.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Focused naming, bench service, and checkpoint tests | Working tree | passed | 65 tests. |
| Local Solve and Verify process runs | Working tree | passed | Used the published RoboCerebra case ID and an over-limit fixture with a test adapter. Both stages completed. The case ID stayed intact and the generated names fit the contract. |
| `pnpm verify` with two workers | Working tree | failed | AgentDojo and embodied adapter tests hit the Python subprocess timeout. |
| `pnpm verify` with one worker | Working tree | passed | 49 script, 1,028 Orbit, and 163 Web tests passed. Orbit skipped 32 opt-in tests. Both builds completed. |
