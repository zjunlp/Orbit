# Fixed embodied solve batches

Register an independent policy and native benchmark as described in the
[native adapter guide](../../examples/bench-adapters/embodied/README.md). Regenerate benchmark
registrations after updating the adapter or SDK so their implementation digest matches.

```bash
orbit bench run libero-native --method pi05=policy,policyRef=pi05-libero \
  --sample-plan "$SAMPLE_PLAN" --batch-size 8
```

`--batch-size` accepts 2–256; the selected benchmark also declares its own maximum (the native
adapter accepts 128). Without the option, existing single-episode behavior is preserved. The
daemon groups consecutive samples of one method with the same effective resources and timeout
(the job `--timeout` takes precedence over per-task timeouts), preserving sample-plan order. The
grouping is part of the comparison conditions. Each group gets one solve Run, one model service and one resource
lease. Every episode remains an individual Trial with its own evidence directory and CPU verify Run.
`--timeout` is the per-episode budget; the shared Run's watchdog is the sum of its episode budgets.
An episode whose environment step ends past its own budget is invalid, including the last step.

The model's declared random stream continues across the fixed group. Environment and connector
state reset for each episode; service RNG reset is not implied. Batch size, complete ordered sample
plan and resource partition conditions enter comparison fingerprints. A subset with a new model
service does not reproduce a later episode's service-stream prefix. To retry, submit the complete
original plan with the same method, batch size and resource conditions. Consolidation validates the
original prefix and protects valid completed episodes; it does not choose historical best scores.
Adopting a compatible retry retains earlier solve/verify references, outcomes and scoring history
in the Trial's `priorAttempts`. Their shared files remain available until the owning job is deleted.

Cancelling a shared solve Run or its job stops all unfinished episodes in that group, including a
solve that was submitted but not yet linked when the daemon stopped: after a restart the daemon
stops it before scheduling queued work, and its Trials keep cleanup pending until it is confirmed.
Completed
results are sealed before optional video work and still get independently verified after collection.
A later model-service failure or Run OOM does not invalidate earlier verified episodes. Incomplete
evidence receives its own unknown/invalid outcome; the original shared Run's execution state stays
visible. `orbit bench rescore JOB --trial TRIAL` verifies only the selected saved episode, retains its
history and appends a report revision. No model or simulator is loaded for verification.

Trial configuration shows batch position, stream scope and cancellation scope. Solve duration and
resource measurements describe the whole batch. `orbit bench usage` counts a shared Run once per
task and marks shared measurements; it does not divide the peaks into fictional per-episode values.
Shared artifacts stay with their Run and are removed through the finished job's existing deletion
flow. A Run with remaining job references cannot be independently removed.

Before a schema upgrade, the daemon snapshots an existing SQLite database into
`<db>.backups/v<version>.sqlite` and prints that path. SQLite creates the snapshot with committed
WAL contents included; Orbit opens it independently, checks integrity and schema version, then
migrates the original in one transaction. A failed backup or migration prevents startup. Backups
are private; a retried upgrade replaces the backup of the same version rather than adding copies.

To inspect a recovery copy, stop the daemon for that home and preserve its database and WAL files.
Copy a validated `.sqlite` backup into a separate home as `orbit.db`, retain the original configuration
JSON files and configure the appropriate data directory before starting Orbit there. Start with
terminal jobs when validating a copy; active jobs belong to the original home. Do not combine the
snapshot with unrelated WAL files. The new home migrates its copy and keeps another original-schema
backup. Existing job documents, report revisions and solve evidence are not rewritten by migration.
