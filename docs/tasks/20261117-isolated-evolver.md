# Isolated reference evolver (V3)
branch: feat/isolated-evolver · status: completed · updated: 2026-11-17

## Goal
Run the reference instruction editor inside an existing Orbit Run with evolve-only input; keep evaluation and promotion outside.

## Changes
- Ship submit/collect helpers and a minimal container launcher with the orbit-evolve skill.
- Verify frozen evolve membership, exact parent identity, export integrity and conservative provenance before one bounded editor Run.
- Reject host networking, ambient project mounts, non-instruction bundles and unsafe output paths; collect via the existing authenticated API after cleanup, token and change-budget checks.
- Document trusted-controller/network boundaries and the existing E4/V1 handoff; no new daemon state or execution loop.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Boundary regressions | V3 tree, base d70cdf9 | passed | Real files; traversal/links, evidence scope, changed spans, network configuration, cleanup and unknown/over-budget tokens |
| pnpm verify | V3 tree, base d70cdf9 | passed | Format, lint, types, boundaries, 1,157 tests and builds; 32 opt-in tests skipped; existing isolated Python dependencies |
| Installed package smoke | V3 tree | passed | Actual tarball installed outside checkout; helper loads published contracts and validates/materializes files; separately copied skill resolves installed runtime; CLI, daemon, Web and nested resources |
| Real Codex isolation | V3 tree | passed | One genuine editor Run, API output collection and E4 preflight; real container inspection and same-mount probe reject host/held-out reads, input writes, Docker socket and daemon access |
| Connectivity probe | Development environment | failed | Direct bridge HTTPS unavailable; real editor used an IP/domain-restricted temporary model proxy |
| Cost / cleanup | V3 tree | passed | Measured editor input+output below prospective cap; all validation Runs cleaned, no active leases or containers; proxy port closed and private daemon stopped |
| Skill structure | V3 tree | passed | Shared skill validator; behavior checked separately above |
| Claude checks | — | not_run | User requested no further Claude checks |

## Next / open issues
- V4 comparisons are next. This check establishes isolation/workflow behavior, not benchmark improvement.
- Current editor supports Codex and Markdown instruction bundles; bridge networking is not a general egress allowlist, and token caps are checked after execution.
