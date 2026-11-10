# Native LIBERO-Plus

branch: feat/embodied-eval · status: completed · updated: 2026-11-09

## Goal

Expose the four released LIBERO-Plus perturbation suites through the native C6 adapter.

## Changes

Pin the simulator and asset identity, use one native initial state per variant, and report success by perturbation category. Check the mounted simulator assets once before a solve Run starts. Reuse the independent OFT policy interface. [Registration guide](../../examples/bench-adapters/embodied/LIBERO-PLUS.md)

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Catalog and reset assets | `4976dc3` | passed | Checked all 10,030 variants against the native resolver. |
| Native GPU and OFT integration | `4976dc3` | passed | Sampled all perturbation categories across the four suites and verified saved OFT evidence. |
| Full-suite model evaluation | `4976dc3` | not_run | Model validation used a sample. |
