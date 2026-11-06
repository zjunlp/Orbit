# Bounded policy integration checks

Register the native benchmark and real model policy, then prepare a frozen sample plan containing
2–5 episodes. Prefer different initial states of a representative task. See the
[native adapter guide](../../examples/bench-adapters/embodied/README.md) for registration and planning.

```bash
orbit bench calibrate libero-native --policy groot-n17-libero \
  --sample-plan "$SAMPLE_PLAN" --budget 20
```

The benchmark must support fixed batches. Calibration fixtures cannot stand in for real models in
this mode. The plan is used as supplied; task sampling and legacy seed/oracle flags do not apply.
The existing `empty`/`oracle` calibration command is unchanged when `--policy` is absent.

The daemon creates an ordinary BenchJob with fixed batch membership. Compatible episodes share
their solve Run and model service. Each episode independently verifies its saved evidence on CPU;
by default, the first episode is also rescored without rerunning the model. A valid native failure
score can pass the integration check: model task success and integration validity are separate.
The report checks frozen identity, shared execution, trusted scores, CPU verification, rescore and
cleanup. A successful policy check does not raise the benchmark's semantic-calibration or fidelity
status. CLI and Web identify the scope as sampled policy integration.

`--budget` defaults to 20 minutes and accepts a positive value up to 30. This is the total wall-clock
budget from job creation, including queueing, model startup, solve, verification and automatic
rescore. At exhaustion, the daemon records the deadline failure, stops unfinished solve/verify work
and skips further verification/rescore. It still waits for confirmed cleanup before the report ends.
Cleanup can extend beyond the execution budget. Restart preserves the original deadline; expired
work receives stop intent before recovered queued Runs are scheduled. Closing the CLI does not
remove the daemon's budget. `--wait` only limits how long the CLI waits for a report.

Cancellation also finds job-owned Runs persisted before their Trial linkage was written. Acceptance
waits for all owned current and historical Runs to terminate, finish cleanup and release their
leases. A successful new verifier does not hide an older verifier awaiting cleanup; cleanup events
resume the waiting report without rerunning the model or verification.

The policy command exits nonzero if the requested integration check does not pass. Results and
incomplete checks stay visible; reaching the deadline is never reported as a pass. Evidence and
previous scores remain available. Bounded policy checks cannot adopt results through consolidation.
An explicit later CPU rescore can inspect saved evidence, but does not erase the original exhausted
acceptance budget or turn that incomplete check into a pass.

Web Catalog → Calibrate offers a registered-policy name, a sample-plan JSON file and the total
budget for policy-only benchmarks. The expanded row lists policy checks separately from benchmark
calibration. The CLI's `--json` response includes the policy, episode count, budget/deadline and
individual checks.

These checks are intended to keep normal onboarding near a 10–30 minute validation budget once
assets are ready. Benchmark native-semantic calibration and complete-suite statistical equivalence
need their own evidence and declared scope; this command makes neither claim.
