# Reference evolver (V1)

The `orbit-evolve` skill ships with the existing Orbit plugin. The host Agent reads evolve-set
failure trajectories, edits a copy of an instruction/skill bundle and uses the existing Orbit CLI
to evaluate it. The daemon still only executes, records and judges; it does not start an evolver,
maintain another experiment ledger or run an unattended search.

Install through `orbit plugin install` and restart the host. The skill names are listed in the
[plugin guide](../../plugin/README.md). Source development can use
`node packages/orbit/src/bin.ts`; verify that the installed CLI has trajectory export and gate plan.
The skill and a small generic `assets/minimal-bundle/AGENTS.md` are copied into npm packages for
pi/dsh and discovered from the same source directory by Claude Code/Codex plugins. The starter is
for a newly evaluated baseline, not a replacement for a parent's missing historical bundle.

For controlled comparisons, [V2 baselines](evolution-baselines.md) provide no-change A/A, cumulative
bounded notes and a pinned ACE adaptation through this same skill. The reference edit remains the
default for ordinary improvement requests.

## Inputs and limits

Start with a known parent revision and its exact bundle, Agent/model/effort/auth, frozen E1 task
files and policy, and a valid parent evolve job. [V0](evolution-pilot.md) provides the cost/noise
planning procedure. Set round count, added + deleted line and edited-file byte limits, per-trial
timeout and a total new-evaluation token budget before the first candidate. Include smokes, parent
runs, invalid attempts and retries in that budget. Reused parent evidence has historical costs,
which should be reported separately. Reserve the next stage's estimated tokens and outstanding
jobs; missing cost coverage does not count as zero.

The host handles those limits. Orbit's timeout bounds execution time, but it cannot stop a model
call at exactly a token threshold. State and report any in-flight overshoot and stop further work.
If the editor's host cannot report its own tokens, mark them unknown and scope the measured budget
to Orbit evaluations; do not claim an all-LLM cost cap. A requested hard total cap needs a metered
editor as well. Limits do not authorize additional spending or changing the user's intended scope.

## One round

1. Export only valid failed parent trials from the frozen **evolve** set. Read the manifest and
   exported trajectories; their contexts supply the original trial IDs used for `--informed-by`.
   Default credential scanning still rejects unknown hits. If needed, explicitly use
   `--sensitive-text redact`, inspect its omission list and use only evidence that remains meaningful.
2. Copy the exact parent to a new directory outside the source checkout. Infer a general failure
   mechanism and edit only `AGENTS.md`, `CLAUDE.md` or `skills/` text within the change budget.
   Keep task IDs, answers and reference-specific lookup rules out. Preserve the parent unchanged.
3. Run `bench gate check-bundle`, retain the digest and freeze the candidate for this round.
   Run a small evolve smoke with the same conditions, plus `--parent`, `--note` and every used
   `--informed-by` trial. Inspect its revision basis and validity before committing more cost.
4. Use `bench gate plan`. Resolve missing, pending, ambiguous or blocked evidence with the
   [existing gate workflow](bench-gate.md). Execute only the next authorized stage, retaining
   generated revision/task SHA guards and lineage. Gate first, then guards; finals are separate.
5. Save `bench gate` with explicit immutable report selections when needed. Exit codes 0/2/3 mean
   accept/reject/insufficient; 1 is an input/API error. Only accept adopts the child. Otherwise retain
   the parent, record the reason and stop or make another evolve-only candidate within the limits.

The complete command examples and decision rules are in the shipped
[skill](../../plugin/skills/orbit-evolve/SKILL.md). It can be used from any supported host; it is not
an Orbit-specific Agent loop. Editor isolation is still V3: `informedBy` and evolve-only reading
are explicit workflow claims here, not proof that the editor physically could not access held-outs.

Small task populations remain insufficient at the original policy thresholds. A bounded development
round can validate a real child revision, lineage and persisted verdict while being far too small
to establish improvement. Never relabel that as a promoted configuration or a cross-environment
result. Do not shrink the required task count or change margins to get a passing demonstration.

Store candidate directories, exports, diffs, chosen reports, budgets, verdict IDs and conclusions in
user-owned notes outside Git. The repository contains the reusable skill, example and validation.
