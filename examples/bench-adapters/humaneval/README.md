# HumanEval: fixed-input code generation

Direct external SDK adapter for [openai/human-eval](https://github.com/openai/human-eval/tree/312c5e5532f0e0470bf47f77a6243e02a61da530)
at commit `312c5e5532f0e0470bf47f77a6243e02a61da530`. The registered path is a checkout holding
the upstream `HumanEval.jsonl.gz`; the adapter checks its SHA256 before listing or running a task.

A trial is one of the 164 problems. The subject sees only the prompt (signature and docstring) and
returns a completion; tests and the canonical solution stay hidden.

## Declaration

| Field | Contract |
| --- | --- |
| Identity | Upstream commit above and `HumanEval.jsonl.gz` pinned by SHA256. A mismatch fails the task listing instead of grading different problems. |
| Category | `fixed-input`; profiles `generate` and `exec-test`. One trial = one problem. |
| Input / visibility | Prompt only. `oracle` receives `canonical_solution` deliberately; `empty` submits an empty completion and `external` an OpenAI-compatible chat model. CLI Agents are refused: C1 grades a single completion, not a session. |
| Output / stop | One completion per trial. No environment, no multi-turn loop. |
| Resources | `python:3.11-slim` by digest, no GPU, no devices, no network in verify. |
| Scoring | The upstream check program runs `prompt + completion + test + check(entry_point)` with a 3 s limit per problem, matching `evaluate_functional_correctness`. Binary pass@1; seeds are repeated samples. |
| Review | `problem.json`, the completion and the verifier's original check output. |
| Trust | Verify re-runs the check from saved solve output with network disabled and recomputes the score; a solve-side score never decides the result. |
| Calibration | `oracle: max`, `empty: min`, `repeat: exact`. The empty completion leaves the body blank, which is a syntax error and fails every test. |

## Fixtures

`subject.py` shapes the completion request and `check.py` mirrors the upstream check program. Both
are covered by `test_adapter.py` without contacting a model.
