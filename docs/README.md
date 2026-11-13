# Orbit documentation map

Where each kind of document lives and which one is authoritative. Rules for keeping them are in
[AGENTS.md §5](../AGENTS.md).

| Document | Purpose | Authority |
| --- | --- | --- |
| [design.md](design.md) | Architecture, contracts, module boundaries, decisions | Only source for design; update in the same branch as the change |
| [status.md](status.md) | What works now, main gaps, next steps | Current state; replace, never append history |
| [evolution-plan.md](evolution-plan.md) | Work packages for unified trajectories, export, fork, the evolution gate and evolution experiments | A plan, not a specification; decisions move into design.md as each package lands |
| [catalog.md](catalog.md) | How to read the benchmark product library | Data lives in `packages/orbit/src/bench/benchmarks/` |
| [guides/](#guides) | How to use an implemented feature | Implemented behavior only |
| [tasks/](tasks/README.md) | One record per feature or substantive fix, indexed by topic | Historical; not updated after completion |
| [research/](research/) | Dated upstream-source surveys behind design decisions | Snapshots; not maintained, links may cite external checkouts |
| [ppt/](ppt/README.md) | Offline presentation | Not a specification |

## Describing a benchmark

Every benchmark is described by three things (design §9.10):

1. **Classification**: the six dimensions (design §9.17).
2. **Integration**: method `harbor`, `manifest`, `sdk` or `native` (design §9.14), execution kind (design §9.3) and the concrete adapter.
3. **Validation**: the calibration record (empty / oracle / repeat / cleanup / rescore). Only facts, no grades.

The retired C1–C7 categories, L0/L1/L2 tiers and fidelity levels appear only in old task and research records.

## Guides

| Topic | Guides |
| --- | --- |
| Benchmarks | [Add a benchmark](guides/bench-adapter.md) · [Availability of original protocols](guides/benchmark-availability.md) · [GUI evaluation in Web](guides/gui-bench-web.md) · [Python SDK](../examples/sdk/README.md) · [Adapter examples](../examples/bench-adapters/) |
| Embodied | [Quickstart](guides/embodied-quickstart.md) · [Coverage and verified policies](guides/embodied-compatibility.md) · [Onboarding templates](guides/embodied-onboarding.md) · [Fixed batches](guides/embodied-batches.md) · [Policy integration checks](guides/policy-integration-checks.md) · [LIBERO suites](guides/libero-suites.md) · [Development checks](guides/embodied-development.md) |
| Runs and machines | [Trajectories](guides/trajectories.md) · [Checkpoints](guides/checkpoints.md) · [Multi-node](guides/multi-node.md) · [Docker userns-remap](guides/docker-userns-remap.md) |
| Agents and notifications | [Plugins](../plugin/README.md) · [Notifications](guides/notifications.md) |
| Maintainers | [Releasing](guides/releasing.md) |
