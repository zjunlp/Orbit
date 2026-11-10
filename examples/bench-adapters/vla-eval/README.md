# vla-eval: external policy episodes

Direct external SDK adapter for [vla-eval](https://github.com/zjunlp/vla-eval). A trial is one task
of a vla-eval benchmark, run as one episode in the benchmark's own image through vla-eval's direct
entry (`vla-eval run --no-docker`, the command its container uses), so the episode loop and scoring
stay upstream.

This is an execution recipe inside an existing Orbit benchmark family, not a separate family. The
LIBERO product entry lists it as an alternative route next to the native OpenPI/OFT recipes.

## Declaration

| Field | Contract |
| --- | --- |
| Identity | The pinned vla-eval checkout registered as the benchmark path; the benchmark image is pinned by digest in `config`. |
| Category | Independent Policy on a native environment. One trial = one episode; the trial seed selects the initial state (seed 1 → episode 0). |
| Input / visibility | Observations the benchmark produces, passed to the policy service. The policy never receives task ids or grader state. |
| Output / stop | The episode ends when the upstream benchmark terminates it. Actions are the benchmark's own control contract. |
| Resources | Two leased roles: `sim` (the benchmark container) and `policy` (the model server, with its own GPUs). `config.gpus` sets the policy allocation. |
| Scoring | Upstream episode scoring inside the benchmark image. Scalar or binary depending on the benchmark; `rescore` re-reads saved evidence. |
| Review | The episode's saved observations, actions and the verifier's original result JSON. |
| Trust | Verify replays saved evidence with network disabled and recomputes the score; a solve-side score never decides the result. |
| Calibration | `empty` is a real zero-action policy served from the benchmark image: the benchmark runs for real and scores what zero actions achieve. It is a negative calibration, not a "no model" shortcut. |

## Methods

- `external`: `entrypoint` is the model-server **image** (`image` or `image@digest`). `config` carries
  `command` (argv as a JSON array), `serverConfig` (path inside the image), `gpus` and `port`.
- `empty`: the zero-action policy described above.

## Fixtures

`zero_policy.py` is the zero-action server, `check.py` validates the plan shape and `test_adapter.py`
covers planning without a GPU or a model.
