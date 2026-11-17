# Evolution baselines (V2)

The existing `orbit-evolve` skill supports three baseline variants. They produce an instruction
bundle and reuse [V1](reference-evolver.md)'s frozen tasks, budgets, smoke, lineage and gate records.
There is no additional daemon loop, method registry or experiment store.

| Variant | Editable content | Purpose |
| --- | --- | --- |
| `no-change` | Nothing; exact copy including executable bits | Independent A/A noise control, same revision |
| `bounded-notes` | Append only to AGENTS.md within a fixed cumulative line cap | Minimal failure-learning control |
| `ace` | Incremental structured AGENTS.md playbook; stable IDs and feedback counters | Published-method adaptation |

Ask the host to use `orbit-evolve` with the chosen variant. Its
[baseline instructions](../../plugin/skills/orbit-evolve/references/baselines.md) contain the request
format, commands and A/A report selection. The default reference edit remains available. Installation
uses the [same three skills](../../plugin/README.md); these are variants, not extra installations.
All method references and the helper ship in native plugins and the npm package. These variants
write AGENTS.md; confirm that the subject Agent loads it before establishing the baseline. Host
plugin availability does not establish support for every subject Agent.

## Deterministic construction

```sh
node /installed/orbit-evolve/scripts/build-baseline.mjs /outside/request.json
```

The dependency-free helper reads a JSON request, snapshots the parent and creates a new bundle
without changing the source. Relative paths resolve against the request's directory. It rejects
existing/nested outputs, symlinks, unsupported edits, malformed playbooks and exceeded budgets
before publishing a candidate. The output JSON reports the charged line span, changed-file bytes,
file count and cumulative note count. It neither calls a model nor reads/writes daemon state.

For notes, `base` is the original common parent, held fixed across rounds; all files except the
AGENTS.md suffix must retain its content and executable bits. Line limits include all appended
notes, and the changed byte limit counts the entire resulting file. ACE's headers and counters
also consume its edit budget. Limits stay fixed; exhausting them stops this variant.

Construction does not check semantic leakage or credentials. Review the full diff and use the
existing `bench gate check-bundle`; its digest is the authoritative Orbit bundle identity. Freeze
that bundle through smoke and held-out evaluation and retain expected revision/task SHA guards.

## ACE source and boundaries

[ACE](https://arxiv.org/abs/2510.04618) separates generation, reflection and playbook curation.
Orbit uses the authors' [official implementation snapshot](https://github.com/ace-agent/ace/tree/82709de050e1db6e6ef2f07bcb0393560b94992a)
for the serial ADD/feedback-counter mechanism. Its executable updater supports ADD; the optional
semantic deduplication path is disabled by default upstream. See the shipped
[ACE method](../../plugin/skills/orbit-evolve/references/ace.md) for exact source files and rules.

Orbit's subject Agent supplies the existing valid failed evolve trace. The host separately records
reflection and curation, then applies deterministic ADD operations and feedback counters to a copied
bundle. This adaptation uses failure-only evidence without reference answers, retains the parent
prefix, and enforces Orbit budgets. It does not launch the upstream trainer, reproduce its benchmark
numbers, perform semantic pruning, or search model/runtime/harness settings. Reports must identify
it as **ACE adaptation**, including the host model and unmeasured editor tokens.

## Fairness and interpretation

Methods start from the same parent and selected evolve evidence with the same prospective limits
and held-out policy. Do not feed one method's child to another, select candidates from gate failures,
reuse the same solve as both A/A sides, or alter thresholds after results. Shared parent evaluations
are identified once in study totals; new attempts and retries always count toward each budget.

A/A requires `--calibration-aa`, the same revision, independent jobs and explicit immutable report
references under a gate-only calibration policy. Preserve the production policy. It never promotes
a configuration. Edited variants declare parentage and every actual `informedBy` trial; only an
accept adopts a child. Missing coverage and inconclusive differences remain insufficient.

A bounded real development check demonstrates that the variants produce valid bundles, execute
through the existing Agent integration and save correctly labelled verdicts. It does not establish
which method improves performance. Editor isolation is V3; powered comparative chains are V4.
Keep personal jobs, proposals, budgets, scores and conclusions in user-owned notes outside Git.
