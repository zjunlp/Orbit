# Native embodied evidence and comparison fixes
branch: feat/embodied-eval · status: completed · updated: 2026-11-06

## Goal

Fix consolidated rescore provenance, sample-content verification, paired evaluation conditions
and resolved execution budgets in C6 plan fingerprints.

## Changes

- Preserve the original execution trial across repeated consolidation; new native evidence also
  records its solve Run. Verify saved legacy evidence against its available original provenance.
- Recompute sample identity and check evidence against frozen sample, binding, policy, reference
  and implementation snapshots. Bind the verification receipt to its current trial and solve Run.
- Share normalized frozen evaluation conditions between C6 plan fingerprints and paired statistics,
  including effective per-task resources and timeout. Preserve legacy report digest behavior.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Python 3.8 / 3.11 SDK checks | working tree | passed | 26 each; resealed sample/snapshot changes, Run identity, version downgrade, legacy compatibility and host planning without third-party packages |
| `pnpm verify` | working tree | passed | 5 script + 609 Orbit + 69 Web tests; 26 existing skips; lint/types/boundaries/build passed |
| Store/planning regression with synthetic Runs | working tree | passed | Two consolidations followed by rescore; each budget dimension independently rejects pairing and changes the fingerprint; equivalent effective timeout remains paired |
| Real saved native evidence, CPU rescore | working tree | passed | Prior model and calibration evidence remains verifiable; solve artifacts, verdicts and history preserved; no model inference |
| Real native consolidation/rescore development check | working tree | passed | Disposable zero-action calibration on LIBERO; version-2 Run identity, two successive consolidations and CPU rescore; cleanup confirmed and leases released |

## Next / open issues

Independent-process numerical repeatability and full-suite statistical equivalence remain separate,
unresolved validation work; they were not rerun for these evidence and reporting fixes. Legacy
evidence without recoverable original-trial provenance fails verification rather than inventing it.
