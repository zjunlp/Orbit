# Evolution gate

`orbit bench gate` compares two configuration revisions using a frozen policy and existing immutable
reports. It saves the policy, verdict and evidence together. It does not submit benchmark jobs.
The statistical rules and limitations are described in [gate-core.md](gate-core.md).

## Freeze the policy

First create task files with [bench split](task-sets.md), and submit parent/child jobs with
`bench run --tasks-file`. The child must declare `--parent` and any `--informed-by` trial references.
The policy's benchmark is its stable identity ID, which may differ from its registration name.
Task file SHA-256 values are the hashes in `split.json` (or of the exact UTF-8 file bytes).

```yaml
version: 1
alpha: 0.05
min_paired_tasks: 30
min_coverage: 0.9
change: bundle-only
gate:
  benchmark: my-benchmark
  tasks: { file: gate.txt, sha256: REPLACE_WITH_64_HEX_DIGITS }
guard: []
final: []
cost: { max_wall_ratio: 1.5, max_token_ratio: 1.5 }
```

Paths resolve relative to the YAML file, not the current directory. The CLI reads bounded UTF-8
snapshots; the daemon validates them against the policy before evaluating. YAML duplicate keys,
unknown policy fields and changed files are rejected. Policy files are limited to 1 MiB; task files
to 8 MiB each, 32 MiB in total and 32 datasets. Full policy defaults are frozen into the saved record.
Rules are user-declared: saving a policy with a verdict does not prove it was chosen before seeing results.

Each `gate`, `guard[]` or `final[]` dataset may specify `metric`; it defaults to the top-level
`metric`. Select the exact declared metric saved in that family's immutable reports (for example,
Harbor's `resolved` alongside another family's `score`). Margins and thresholds use the selected
metric's native units; there is no aliasing or automatic score conversion. Both sides must report
the same selected metric. Older policies retain their top-level metric behavior.

## Plan evaluations and check bundles

E4 adds two read-only helpers:

```bash
orbit bench gate check-bundle /path/to/candidate --policy /path/to/gate.yaml --json
orbit bench gate plan --policy /path/to/gate.yaml --parent PARENT_REV --child CHILD_REV --json
```

Both revisions must already be recorded, usually by an evolve-set smoke. `plan` uses the same frozen
input validation, evidence history and prerequisite checks as evaluation. It lists each set and side
as available, missing, pending, ambiguous or blocked. Pending work is not duplicated; multiple report
revisions require `--reports` just as for evaluation. A finished legacy job without reports receives
an explicit `bench report` suggestion; planning never backfills reports or saves a gate record.

A missing result can receive a `bench run` command built from an unambiguous saved CLI method and
benchmark execution template. Commands preserve seeds, options, checkpoint settings and declared
lineage; task paths resolve against the policy file. They include `--expect-tasks-sha256` and
`--expect-revision`: changed task bytes or method/bundle/CLI content are rejected before a job is
created. These flags can also be used directly with `bench run`; `--expect-revision` requires one
method. API submissions use the transient `expectedRevisions: {methodName: revision}` field, which
is not stored in job specifications.

Commands remain suggestions. Reconcile changed benchmark registrations, conflicting templates,
unknown revisions or methods that cannot be represented by `--method` first. Frozen sample-plan
jobs require an explicitly selected plan file; the helper does not invent a replacement. Review
prerequisites even when both reports are available: stale conditions remain insufficient.

`check-bundle` reads the directory on the daemon's machine. It shares the existing revision digest
reader, but confines links to the bundle directory. It checks regular files (including hidden files),
executable bits, size/file limits, known credential patterns and structured JSON secret fields,
literal IDs from all held-out task files, and explicitly declared reference SHA-256 values.
Optional frozen policy settings tighten the existing hard limits:

```yaml
bundle:
  max_files: 200
  max_bytes: 1048576
  reference_sha256: []
```

The hard limits remain 2,000 files / 64 MiB, with 20,000 directory entries and 64 levels. Inspection
errors, cycles, external links and exhausted matcher limits fail the check. Findings identify files
without printing suspected secret values; at most 100 findings are returned. A reference match means
an identical file or a literal digest in the bundle. With no reference hashes, that check is explicitly
`not_run`. Compressed, encoded or paraphrased answers and unknown secrets are not certified absent;
literal short task IDs can produce conservative substring matches. A passed preflight is not proof
of isolation or absence of leakage, and the returned digest identifies the inspected bytes only.

Suggested cost order: static check → evolve smoke → gate → frozen guard sets → final sets and a second
Agent after several accepted rounds. The shipped `orbit` skill documents this order. These helpers
never submit work or advance an evolution loop automatically.

Exit codes: `plan` uses **0** when required reports and prerequisites are available, **2** for missing,
pending, ambiguous or blocked required evidence. `check-bundle` uses **0 passed**, **2 failed**.
Input/API errors use **1**. Optional final evidence is listed without blocking the required plan.

## Evaluate and select reports

```bash
orbit bench gate --policy gate.yaml --parent PARENT_REV --child CHILD_REV
orbit bench gate --policy gate.yaml --parent PARENT_REV --child CHILD_REV --reports reports.json --json
orbit bench gate list --child CHILD_REV
orbit bench gate show RECORD_ID --json
```

Automatic selection is allowed only when each side has exactly one stored report/method matching
its revision, benchmark, metric and task-file hash. Multiple jobs or rescored reports require an
explicit `--reports` JSON file; Orbit never chooses the best or latest result automatically:

```json
[
  {
    "set": "gate",
    "parent": { "job": "PARENT_JOB", "revision": 1, "method": "baseline" },
    "child": { "job": "CHILD_JOB", "revision": 1, "method": "candidate" }
  }
]
```

Other set names are `guard:0`, `guard:1`, and `final:0:codex` (the final dataset index and Agent name).
Missing required evidence produces `insufficient`; unknown or ambiguous explicit references are
request errors. Legacy reports are not silently rebuilt from current Runs or Trials during gating.
Use the existing report command separately if an old job needs its initial backfill.

Exit codes for evaluation: **0 accept**, **2 reject**, **3 insufficient**; input/API errors use **1**.
`list` and `show` are read operations and do not reuse the stored verdict as their process exit code.
`--json` returns the complete record, including its immutable evidence snapshot.

## API and records

- `POST /bench/gates/plan`: the same input as evaluation; read-only plan and prerequisite checks.
- `POST /bench/gates/check-bundle`: `{directory, policy, taskSets}`; daemon-local read-only preflight.
- `POST /bench/gates`: `{parent, child, policy, taskSets: [{file, content}], selections?, mode?}`.
- `GET /bench/gates?child=REV&limit=100`: newest-first summaries (maximum 500 per request).
- `GET /bench/gates/ID`: full record with policy, evidence and verdict.

The daemon derives related history and leakage references from its stored jobs and reports, without
the normal job-list pagination limit. It also retains history captured in prior gate records after
source job deletion/consolidation. Every evaluation creates a new immutable document in the existing
SQLite store; there is no mutable winner or gate state machine. Old records remain reproducible after
source reports change or disappear. Evidence that was deleted before any gate captured it cannot be
recovered; callers must retain their assessment history. No current Run costs are substituted.

## Web verdict review

**Configurations → Gate records** opens `/configurations/gates`. Each configuration's version lineage
shows recent verdicts with links to the full history for that child revision. The list shows up to
100 newest records and supports an exact child-revision filter; it is not a mutable current winner.
Records from different policies remain separate. A/A calibration is labelled separately and has no
promotion badge or level.

Open a record to inspect the decision, missing prerequisites, performance/guard/cost checks, one-sided
bounds, candidate round and alpha, frozen policy and report selections, and excluded tasks. Missing
checks and rejected checks have distinct labels. **Compare trajectories** on a regressed task selects
paired samples from the exact saved report revisions. The parent and child panels load the recorded
solve Run IDs and navigate independently; equal step numbers do not imply equivalent actions.

Later retries and rescoring cannot silently replace these attempts. If a source Run was deleted, its
trajectory is unavailable while the saved report value and gate evidence remain visible. Trial links
explicitly open the current trial view. Full JSON is available from the record's provenance section.

## A/A calibration

```bash
orbit bench gate --policy gate.yaml --parent SAME_REV --child SAME_REV \
  --calibration-aa --reports independent-runs.json --json
```

This explicit mode compares two independent jobs of the same configuration, using the first-round
alpha and the same statistics/coverage/validity/cost checks. It requires identical revisions, only
the gate dataset, and disjoint trial and solve-attempt IDs. Its records are labelled `calibration-aa`
and never receive a promotion level. A statistical improvement in this mode is a false-positive
signal to investigate, not a configuration upgrade. It does not create a new child or consume a
promotion round. Normal evaluation still requires different bundle content and declared parentage.

The [development calibration](../../examples/gate-calibration/README.md) provides bounded real-CLI
checks and a replay/resampling script. Synthetic tests additionally cover changed CLI metadata,
inherited leakage and missing evidence. Small development tasks do not establish benchmark-wide
power or general guarantees for adaptive reuse of a fixed gate set.
