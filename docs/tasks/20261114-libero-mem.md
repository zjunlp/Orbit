# Native LIBERO-Mem

branch: feat/embodied-eval · status: completed · updated: 2026-11-14

## Goal

Evaluate sequence completion with the native LIBERO-Mem scenes and initial states using Orbit's independently registered LIBERO policies.

## Changes

- Register all ten ordered BDDL tasks and 20 published initial states per task.
- Use native sequence and alternative-branch progression, ten warm-up controls, a per-task horizon and eight policy actions per query.
- Freeze each BDDL goal branch and record ordered progress with original object IDs. Verify branch prefixes, per-episode completion and entire-sequence success from sealed evidence.

## Validation

| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Native image, catalog and reset | working tree | passed | Planned all 200 samples. All ten tasks reset, rendered and took a native control. |
| π₀.₅ short GPU smoke | working tree | passed | One frozen sample ran in the native container pair and passed independent CPU evidence verification. |
| Orbit end-to-end and CPU rescore | working tree | passed | π₀.₅ ran the same frozen sample using an independently configured CPU policy service. Orbit Verify and rescore agreed. |
| Full-suite model evaluation | working tree | not_run | The recorded rollout checks use a single initial state. |
