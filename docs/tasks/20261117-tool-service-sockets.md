# Native tool-service startup
branch: feat/remaining-benchmarks · status: completed · updated: 2026-11-17

## Goal

Make AgentDojo and AppWorld live tool services start reliably while retaining private native
state, trusted evidence collection and fresh-environment verification.

## Changes

- Share a per-trial Unix HTTP socket through the existing service bind mechanism. Native services
  have networking disabled; subjects receive only the client, transport and socket directory.
- Remove the extra internal Docker bridge. The standard solve network remains daemon-managed.
- Pass executable health-check arguments without Dockerfile's `CMD` token, which Orbit previously
  attempted to execute as a shell command. Health checks now query the actual tool endpoint.
- Keep original prompts, tools, grading inputs and service-collected traces behind the same boundary.
- Exercise HTTP GET/POST/error handling and verify isolation with the real Run contract.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Socket transport and adapter fixtures | working tree over 43c81eb | passed | Real local socket round trip; explicit synthetic payloads and native planning fixtures. |
| AgentDojo live service and independent replay | working tree over 43c81eb | passed | Real container health, subject tool calls, service evidence, native replay and cleanup. |
| AppWorld live service and independent replay | working tree over 43c81eb | passed | Real container health, native subject actions, service evidence, native replay and cleanup. |
| Full pnpm verify | working tree over 43c81eb | passed | Node 24 and repository CI Python dependencies; BLAS threads limited to one. Initial unconstrained attempt hit an unrelated embodied adapter timeout. |

## Next / open issues

- A default solve bridge is still required; fully exhausted Docker pools remain an infrastructure limit.
- Offline reference/empty checks and sampled live checks do not establish full-suite equivalence.
