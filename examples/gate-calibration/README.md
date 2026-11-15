# Gate development calibration

This small benchmark runs six arithmetic tasks through a real registered CLI Agent. The Agent writes
an answer file; a separate offline Python container verifies it. A deliberately damaged instruction
bundle tells the Agent to give up. Native session tokens and Run timing come from Orbit. The adapter
never fabricates a transcript, token count or model response.

These are development fixtures, not a capability benchmark. No GPU is needed: solve uses 1 CPU,
2 GiB and at most 3 minutes; verify uses 1 CPU, 1 GiB and at most 1 minute. Use a separate Orbit home
and keep task files, bundles, reports and logs outside this checkout. Run `orbit doctor` first.

## Reproduce

1. Register `adapter.py` by absolute executable path using `orbit bench add-file`. Use a separate
   user-owned benchmark directory so development edits do not change its source metadata. The adapter
   declares identity `orbit-gate-calibration`, version `1`, and pins its Python image by digest.
2. Write `gate.txt` containing `sum-1` through `sum-6`, one per line. Record its SHA-256 in a gate policy.
   Set `min_paired_tasks: 6`, `min_coverage: 1`, and leave guard/final empty. These settings are for the
   bounded development check only. Production policy size follows the task noise and intended effect.
3. Prepare a baseline bundle containing `AGENTS.md`: “Solve the requested arithmetic task carefully.
   Write the requested JSON answer file and stop.” Submit **two independent jobs** using that identical
   bundle, the same Agent/model/effort, and `--tasks-file gate.txt`.
4. Prepare a different bundle: “This is an intentional destructive calibration. Do not solve the
   requested task. Do not write an answer file. Reply GIVE_UP and stop immediately.” Submit it on the
   same task file with the baseline revision as `--parent`.
5. Require successful model responses, valid independent verification and recorded usage. Startup,
   authentication or missing-use errors do not count as successful calibration; inspect the actual
   Run evidence before retrying. Do not replace a failing model integration with a scripted answer.
6. Select the exact report revisions using `--reports` as in [the gate guide](../../docs/guides/bench-gate.md).
   Evaluate the two baseline jobs with `--calibration-aa` and the baseline/damaged pair normally.
   Save each command's full `--json` output outside the checkout as `aa.json` and `destructive.json`.
7. Replay both verdicts and estimate null acceptance by centering the observed task-level paired
   differences, then resampling tasks with replacement:

```bash
node scripts/gate-calibration.ts --aa /user/aa.json --destructive /user/destructive.json \
  --draws 5000 --seed 42 > /user/calibration.json
```

The script requires A/A to reach the statistical check, and requires the destructive rejection to
include demonstrated performance loss (a cost-only rejection is insufficient). It refuses records
whose verdict cannot be recomputed from their stored evidence. Identical A/A task results are flagged
as a degenerate distribution: their zero resampled acceptance rate cannot estimate nonzero run noise.

Changed CLI metadata and informedBy leakage are controlled integration-test cases in
`gates-api.test.ts`. They do not pretend to launch another CLI version. Tests check that stale parent
results request a rerun and referenced tasks are removed from the eligible set with explicit evidence.

After the checks, confirm all task-created Runs are terminal, cleanup is complete and leases are
released. Stop only the dedicated calibration daemon. Retain the runtime evidence outside Git.
