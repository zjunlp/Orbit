# Cross-environment evolution studies

V4 provides repository research helpers for a prospective comparison of target-only admission and
target-plus-guard admission. Execution uses the existing [isolated editor](isolated-evolver.md),
`orbit bench`, [evaluation plans and immutable gates](bench-gate.md). No daemon evolution loop,
new experiment store or automatic promotion is introduced. These helpers require a source checkout
with dependencies installed; they are not a new npm CLI command or Web transfer matrix.

The implemented scope is Codex, instruction-only changes, fixed unbatched task sets and complete
seed pairing. A second Agent, batched/sample-plan benchmarks and formal effect claims are outside
this helper's current scope. A development preview can end early or have invalid/unrun cells;
that is not a completed comparison.

## Freeze before running

Keep inputs and outputs in a private directory outside the checkout. Start with V0 estimates and
E1 evolve/gate/final splits. Do not select or change tasks, thresholds or budgets based on observed
admission/final scores. Final tasks may share a benchmark family with a guard only when they are
in disjoint frozen partitions; label this as task holdout, not an unseen environment family.

Create `plan.json` using the exported `StudyPlan` interface in
[`scripts/evolution-study.ts`](../../scripts/evolution-study.ts):

| Field | Required content |
| --- | --- |
| `version`, `scope` | `1`; `preview` or `comparison` |
| `history` | `separate-homes` for comparisons; `shared-family` is allowed only for previews |
| `initial` | Exact `MethodRevision` from a saved parent job, including its bundle digest and Agent/model/CLI/auth-kind basis |
| `rounds`, `chains` | A common positive round limit; unique `{id, arm}` entries, at least two chains per arm with equal counts; arms are `target-only` and `guarded` |
| `policy` | One parsed `GatePolicy`: target gate, nonempty guards, and at least two final datasets with `agents: ["codex"]`; retain each benchmark's original metric |
| `taskFiles` | `{file, content}` for each policy task file; SHA-256 must match the policy |
| `splits` | Each E1 `split.json` as `manifest`, plus `content: {evolve, gate, final}` containing the exact file text |
| `conditions` | One condition template based on a saved `BenchJob` per benchmark: source, adapter/config, options, metrics, seeds, resolved resources and timeout; do not include credentials |
| `editor` | `implementationSha256`, `model`, `effort`, `changedLines`, `changedBytes`, `tokens`; hash the actual V3 helper/assets used and save its source revision |
| `budget` | Positive `tokens`, common `perChainTokens`, and `finalReserveTokens`; chain allocations plus final reserve must fit the global cap |

`conditions` jobs must describe the intended resource settings for **every selected task**, including
per-task overrides. A prior job that used a different resource map is not an interchangeable template.
Resolve missing selected-task overrides from the benchmark resource configuration into the condition
template before freezing; retain the original job separately as evidence. Never edit stored jobs.
The source/split checks and conditions include paths, so formal independent homes should reuse the
same read-only benchmark/data paths. Register each benchmark and auth profile through the CLI/API.

```bash
node scripts/evolution-study.ts freeze /private/study/plan.json /private/study/frozen.json
```

This validates partition hashes and membership, disjoint task sets, balanced arms, conditions and
budget reservations, then writes a new file exclusively with owner-only permissions. Its digest
covers both the parsed plan and timestamp. Keep the original frozen file; a material redesign needs
a new study with a new budget accounting for costs already incurred. A digest detects accidental
changes; it is not an independently signed preregistration.

Use **a separate `ORBIT_HOME` per chain** in formal comparisons. E3's inverse-square alpha spending
follows all assessed children in a version family, including rejected children. Sharing a home
would make one chain's tests consume another's history. The analyzer checks that each independent
chain supplies exactly its prior assessed candidates. Prepare its parent evolve evidence in that
home, count those new calls, and use the same starting bundle and editor in both arms. Merely
renaming jobs does not isolate history. A shared-history preview reports the limitation explicitly.

## Run the existing workflow

1. Freeze an interleaved chain order outside Git. Before each submission, collect every newly
   submitted model Run, including editor failures, invalid solves and retries. In shared accounting,
   count a shared baseline once; do not charge it again for each cell. Keep an explicit owner for
   every Run (`shared`, a chain ID, or `final`). Auxiliary model-based judges also need explicit Run
   entries; an omitted external API call cannot be inferred from a benchmark report.
2. Check the global budget and reserve the final stage:
   `node scripts/evolution-study.ts budget /private/study/frozen.json /private/study/runs.json 500000`.
   The last argument is an illustrative estimate for the **next** submission. Require `canSubmit`.
   Also require that the selected chain's measured total plus this reservation fits its frozen
   `perChainTokens`. Shared baseline expenses still consume the global cap. Unknown, unfinished or
   uncleaned Run usage blocks further model submissions; do not fill missing usage with zero.
3. Derive the arm policy with the exported `admissionPolicy(plan, arm)` function: all settings are
   identical except that `target-only` has no guards. Both policies omit final datasets during
   admission. Save those policies and use them for V3 preflight, E4 planning and E3 decisions.
4. Run the V3 `submit`/`collect` helper with the current parent's evolve-only failure export.
   Save its `round.json`, `result.json`, request and implementation digest. Treat an unchanged bundle,
   editor/static failure, smoke failure or exhausted reservation as an explicit stop. Never reuse one
   editor Run as independent edits in multiple chains.
5. Run the candidate's evolve smoke, target gate and, if the target permits it, guards via the
   ordinary benchmark API. Use frozen task hashes, exact method revisions and `--parent` /
   `--informed-by`. E4 identifies reusable parent evidence and missing evaluations. Save exact E3
   records and report selections, including failed and insufficient verdicts. Only `accept` advances
   a chain; `reject` and `insufficient` retain the parent. Do not lower thresholds for a preview.
6. Save each chain's closure time and reason. **After every chain closes**, submit parent and endpoint
   final evaluations. Final results must never go back to editing or admission. If an endpoint is
   unchanged, the same final baseline report may explicitly serve both sides. This creates no new
   independent evidence and has no measured difference/interval. For a separate A/A estimate, run
   independent final jobs and preserve both report references.
7. Final reservations may be spent only after closure. The programmatic
   `studyBudget(frozen, runs, nextTokens, false)` drops the final reserve while still checking the
   global limit. Stop on unknown usage or budget exhaustion; retain failed evidence and represent
   unavailable final cells explicitly.

Token totals use input + output; cached input is already part of input, reasoning part of output.
These are model tokens, not billing dollars. V3 checks its token cap after a Run, so reservations
are estimates, not a token-exact interruption within a model call. Leave headroom, use short
execution timeouts and stop immediately on overshoot. Do not copy auth secrets into a plan or report.
Temporary model networking should cover only the experiment's active containers and required
endpoints. Containers may have multiple Docker network addresses; preserve individual addresses
in any allowlist rather than concatenating them. Close the temporary endpoint after use.

## Capture and analyze

[`scripts/evolution-study-capture.ts`](../../scripts/evolution-study-capture.ts) reads only the existing
HTTP API and writes a portable evidence JSON. It does not start daemons, execute jobs or read SQLite.
Keep the study daemons running until capture finishes. Build `capture-index.json` with:

- `planDigest`: the frozen digest.
- `sources`: `{home, jobs: [{id, owner}], runs: [{id, owner}]}`. List **all** study jobs, including smoke,
  failed/cancelled jobs and learning sources; `runs` adds editors and other model calls. New solve
  attempts are discovered from Trial history and immutable report costs. Historical source Runs
  predating the freeze are retained as provenance and excluded from new usage.
- `rounds`: `{chain, round, editorRun, editorConfiguration, changes, parent, candidate, informedBy,
  gate, stop}`. `editorConfiguration` records the actual frozen editor settings; `changes` is
  `{lines, bytes}` from V3 collection; `candidate` is the exact saved revision or `null`; `gate` is
  the complete API `GateRecord` or `null`. A missing gate needs a terminal reason: `editor-failed`,
  `smoke-failed`, `no-change` or `budget`. Successful gated rounds use `stop: null`.
- `closed`: `{chain, endedAt, reason}`, where completed chains use `rounds-complete` and stopped
  chains use their explicit reason. A budget stop may close a chain before its first editor.
- `finals`: exactly one `{chain, dataset, parent, child}` per chain × final dataset, using zero-based
  dataset indices and exact `{job, revision, method}` report references. For a stage not run, use
  `parent: null, child: null, notRun: "reason"`; never insert invented empty reports or zero scores.

```bash
node scripts/evolution-study-capture.ts /private/study/frozen.json \
  /private/study/capture-index.json /private/study/evidence.json
node scripts/evolution-study.ts analyze /private/study/frozen.json \
  /private/study/evidence.json > /private/study/analysis.json
```

Capture rejects conflicting snapshots/allocations instead of silently replacing a stored verdict
with a newer report. Export exact saved gate snapshots using `orbit bench gate show ID --json`.
Analysis is offline once evidence is captured. Its inputs are trusted controller exports; it does
not prove that an operator never viewed a held-out result or omitted an unrelated external call.

The output separates planned/started chains and assessed rounds. It verifies chain chronology,
editor isolation/settings, evolve provenance, frozen policies and conditions, replays saved E3
verdicts, and rejects early final exposure. Final cells show original metrics, complete-seed paired
task differences and normal-approximation 95% intervals, validity coverage and explicit reuse.
Missing/invalid cells and unknown costs remain visible. Final cells with incompatible evaluation
conditions are quarantined as `incompatible`, without paired scores or intervals. New freezes reject
resource templates that omit selected task overrides. Identical reused endpoints have `diff: null`;
all-invalid cells have no paired score. There is no cross-benchmark total or winner ranking.

Intervals describe tasks conditional on the selected endpoint; they do not treat seeds, repeated
references or shared baselines as independent chains. Several independent chains, sufficient tasks,
a prospectively powered guard and a separate second-Agent plan remain necessary for substantive
V4 conclusions. A preview or a `comparisonCompleted: false` result cannot support them.
