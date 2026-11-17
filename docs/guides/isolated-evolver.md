# Isolated instruction evolution

V3 runs the reference editor as a normal Orbit Run. The container receives a read-only copy of the
parent instructions and valid failed evolve trajectories, and emits a candidate instruction bundle.
The outer controller retains task splits, gate/guard evidence and all evaluation/promotion decisions.

Use the packaged [isolated editor instructions](../../plugin/skills/orbit-evolve/references/isolated.md)
for the request format, commands, isolation boundary and recovery procedure. The resource is also
shipped inside the installed `orbit-evolve` skill; it uses the existing CLI, contracts and output API.

The first version supports Codex with Markdown instruction bundles. A non-host-network auth profile,
a trusted Python 3 image and bridge-reachable model access are required. The helper does not open
proxy ports or alter credentials. Existing host-driven [baseline variants](evolution-baselines.md)
remain available; their editing rules are not automatically imposed on the isolated reference editor.

Before submission, freeze the exact parent digest/revision, E1 evolve file, gate policy and separate
editor/evaluation budgets. Submission verifies and exports evolve-only evidence; collection checks
execution, cleanup, token coverage, change limits and E4 static preflight. The output's entire
`informedBy` list must accompany the subsequent [reference workflow](reference-evolver.md).

The container cannot read unmounted host files. Docker bridge networking still permits model
connections and is not a network allowlist. The trusted image, parent bundle, controller and reachable
services must not contain or expose held-out evidence. This change does not establish statistical
improvement; only the existing frozen gate can decide promotion.
