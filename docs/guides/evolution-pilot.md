# Size an evolution pilot (V0)

V0 measures repeat noise and cost before starting an evolution chain. It does not establish that a
bundle improves anything. Use one target family and two guard candidates with different declared
six-dimensional profiles. Confirm **supported** counts with `orbit bench tasks NAME --json`, CLI
support and a working model connection; catalog size alone is not runnable evidence. Keep the
chosen Agent/model/effort, CLI installation, bundle, resources and environment conditions fixed.

## Freeze and run

1. Run `orbit doctor` and `orbit resources`. Use calibrated adapters and existing auth profiles.
   Resolve model or tool-host startup failures before collecting repeat noise. For Codex builds that
   ship a separate tool host, point `ORBIT_CODEX_DIR` at the complete vendor directory rather than
   a lone binary. Retain those failures separately; never count them as valid behavior or silently replace them with a fake execution.
2. Use [E1 splitting](task-sets.md) for each family in a new directory outside the checkout. Reserve
   enough gate tasks for the intended effect/margin, plus evolve and final tasks. Freeze the seed,
   proportions and suites before seeing answers. A deterministic small sample from **evolve only**
   supplies the pilot; reserve gate/final evidence for later prospective evaluation.
3. Run two independent jobs with the exact same pilot task file and configuration, `--seeds 1` and
   a solve timeout. Retain `--expect-revision` and `--expect-tasks-sha256` after the initial smoke.
   `--seeds` counts repetitions; it does not set an arbitrary environment seed. Some adapters use a
   fixed instance seed. Report that scope instead of claiming independent new environments.
4. Save an A/A record per family through `orbit bench gate --calibration-aa`, selecting the two
   immutable report revisions explicitly. Its temporary calibration policy has only `gate`, points
   to the pilot file and may use a small `min_paired_tasks`. This is a calibration input, separate
   from the future promotion policy and frozen gate partition. Export with `gate show ID --json`.
5. Analyze the records with the repository script. Pair each record and split directory in order:

```sh
node scripts/evolution-pilot.ts \
  --aa /outside/target-aa.json --split /outside/target-split \
  --aa /outside/gui-aa.json --split /outside/gui-split \
  --aa /outside/game-aa.json --split /outside/game-split \
  --effect 5 --margin 5 --alpha 0.05 --power 0.8 > /outside/pilot-summary.json
```

The script reads exported evidence only, replays each verdict, checks independent compatible finished
jobs, source identity/version, frozen file hashes and evolve-only membership. It accepts one
declared metric with range 0..100 per task per job, including scalar scores; additional seeds, batches and sample
plans require another study design rather than pretending they are more independent tasks.
Records may have insufficient valid coverage: invalid/unresolved samples remain in denominators,
only both-valid pairs enter the flip estimate, and no valid pairs means no sizing estimate.

If a report predates final cost collection, optionally pass `--runs /outside/solve-runs.json`:
a JSON array of finalized Run objects exported through the existing HTTP API (`OrbitClient.get`).
Only missing costs for referenced solve IDs are supplemented, using the same cost extraction as
the report builder; the summary names this source and counts supplemented Runs. Neither the
report nor its gate decision is rewritten. Without snapshots, missing costs stay unknown. A shared
verifier that ran inside a now-removed solve container cannot necessarily be rescored; do not rerun
the Agent just to fill cost fields.

## Read the estimates

- **Flip rate** is the fraction of both-valid task pairs with changed scores. The script also reports
  a one-sided approximate 95% Wilson upper bound. Zero observed flips does not mean zero noise.
- **Validity** includes invalid rate, unresolved samples, paired coverage and prerequisite status.
  A low-coverage estimate can be biased; fix infrastructure and collect a prospectively declared
  new repeat, retaining the old one, before relying on a cost/noise estimate.
- **Cost** includes all saved solve attempts, including invalid attempts. It reports input + output
  tokens (cached input and reasoning are not added again), wall time and explicit coverage. Partial
  costs have known subtotals but no claimed complete mean. Wall time is the saved solve Run
  start-to-end interval, which can include service/setup/cleanup;
  it is not pure model latency. Verify and connection-helper Runs, plus work outside those intervals,
  require separate accounting.
- **Sizing** uses first-round inverse-square alpha spending, requested power and a conservative
  bounded-difference variance estimate from the flip upper bound. It floors recommendations at 30
  tasks and checks the actual frozen gate count. Future-round alpha is smaller. This is a normal
  approximation, not a power guarantee or an exact binary-test calculation.

A/A measures repeat noise, not disagreement between a future changed bundle and its parent.
Correlated task templates also weaken the independent-task approximation. Preserve the design's
scenario table and treat pilot estimates as conditional planning inputs; do not replace the table
with an unqualified benchmark-wide empirical claim. Increasing seeds does not multiply task count.

Create the first promotion policy with [E3's schema](bench-gate.md), referencing the frozen gate and
final hashes, the target and two guards, margins, coverage and cost limits. Use a dataset
`metric` override when a family's original primary metric has a different name; keep its meaning
and native scale rather than relabeling saved reports. If a family cannot meet
the declared margin with its available tasks, leave it **insufficient**. Change a margin only as a
new prospective decision; do not relax it to make observed results pass. Final sets can remain
listed without executing them during V0. No second Agent or evolution round is started by this tool.

Personal selections, task files, policies, measurements and run IDs belong in user-owned notes
outside Git. The repository keeps this procedure, analysis code and synthetic regression tests.
