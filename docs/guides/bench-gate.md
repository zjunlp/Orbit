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

- `POST /bench/gates`: `{parent, child, policy, taskSets: [{file, content}], selections?, mode?}`.
- `GET /bench/gates?child=REV&limit=100`: newest-first summaries (maximum 500 per request).
- `GET /bench/gates/ID`: full record with policy, evidence and verdict.

The daemon derives related history and leakage references from its stored jobs and reports, without
the normal job-list pagination limit. It also retains history captured in prior gate records after
source job deletion/consolidation. Every evaluation creates a new immutable document in the existing
SQLite store; there is no mutable winner or gate state machine. Old records remain reproducible after
source reports change or disappear. Evidence that was deleted before any gate captured it cannot be
recovered; callers must retain their assessment history. No current Run costs are substituted.

The Web client exposes these typed operations; the version-chain UI is still E5.

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
