# Preserve Harbor verifier GPU model requirements
branch: feat/benchmark-gap-integrations · status: completed · updated: 2026-11-10

## Goal
Support original Harbor tasks that declare GPU models for an independent verifier without allowing the solver and grader to use interchangeable hardware.

## Changes
- Parse and validate separate verifier `gpu_types`, propagate them into the verifier run, and retain them when reusing the solve environment.
- Keep independently declared environments separate, reject impossible shared-verifier overrides and model restrictions with no GPU reservation.
- Record explicit `gpuTypes=any` deviations for each affected phase.
- Match whole GPU-name tokens in order so form-factor names do not prevent a declared memory variant from matching its hardware.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| Targeted regression suite | working tree | passed | Resource admission, independent solver/verifier selection, inheritance, unsupported layouts and model variants. Uses explicit hardware fixtures. |
| `pnpm verify` | working tree | passed | Format, lint, types, boundaries, 724 core tests, 103 Web tests, 5 script tests and builds; 28 opt-in tests skipped. |
| Real hardware and Docker checks | working tree | passed | A bounded one-GPU Docker run saw exactly one matching card and cleaned up. Preflight rejected an original verifier requiring unavailable hardware before pulling its image. |
| Original production GPU evaluations | working tree | not_run | The suite requires accelerator families unavailable for these local checks. Parser coverage does not establish full-suite scores or hardware parity. |

## Next / open issues
- Original production GPU evaluations still require matching workers. Preserve their hardware requirements when scheduling or rescoring.
