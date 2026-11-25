# vla-eval: external policy episodes

Direct external SDK adapter for [vla-eval](https://github.com/allenai/vla-evaluation-harness). A trial is one task
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
| Input / visibility | Observations the benchmark produces, passed to the policy service. Episode-start metadata can include the benchmark task ID. |
| Output / stop | The episode ends when the upstream benchmark terminates it. Actions are the benchmark's own control contract. |
| Resources | Two leased roles: `sim` (the benchmark container) and `policy` (the model server, with its own GPUs). `config.gpus` sets the policy allocation. |
| Scoring | Upstream episode scoring inside the benchmark image. Scalar or binary depending on the benchmark; `rescore` re-reads saved evidence. |
| Review | The episode's saved observations, actions and the verifier's original result JSON. |
| Trust | The upstream simulator supplies the score. Offline Verify reads and checks its saved aggregate, including the task and initial state. |
| Calibration | `empty` is a real zero-action policy served from the benchmark image: the benchmark runs for real and scores what zero actions achieve. It is a negative calibration, not a "no model" shortcut. |

Pull the configured benchmark image before listing its tasks. The default LIBERO image is pinned
in `adapter.py` and the declarative recipe.

The SDK route uses `<suite>:<instruction>` for unique LIBERO tasks and
`<suite>:@<native-task-id>:<instruction>` for tasks that share an instruction. The policy receives
the original instruction for every task. Select an indexed ID from the current catalog when
running one of the same-name tasks in LIBERO-90. New LIBERO Verify receipts bind to the exact
aggregate checked for the planned task.

For RoboTwin, select a task such as `robotwin:adjust_bottle`. Trials select
scenes in ascending order of the native scene seed. For example, in Clean,
`--seeds 2` runs scenes `100001` and `100002` for that task. To select explicit
scenes, use an ordered list and set `--seeds` to its length. For one scene, pass
`--seeds 1 --option 'sceneSeeds=[100002]'`. Verify checks the native seed and
the configured scenario variant. The result details show the native seed and
the Orbit trial number. For a one-scene registration, calibrate with
`orbit bench calibrate <benchmark> --seeds 1`.

Other benchmarks can supply `config.taskIdentityFields` as a JSON array stored
in a string, for example `'["task_type","case_name"]'`. List stable integer or
string fields from the upstream task descriptor that are also saved on the
episode in its aggregate. The scheme includes the name and suite automatically.
Discovery rejects missing or duplicate identities. Solve selects exactly one
descriptor and Verify checks the episode fields and binds its receipt to the
aggregate. This works with catalogs whose order can change between discovery
and execution.

## Methods

- `external`: `entrypoint` is the model-server **image** (`image` or `image@digest`). `config` carries
  `command` (argv as a JSON array, including the server config path), `gpus` and `port`. The benchmark
  config accepts a positive `timeoutMin` in minutes, including fractional values. Trial overrides take precedence.
  Existing definitions can retain `policyImage` and `serverConfig`. The launcher reads the image
  from `entrypoint` and the server configuration path from `command`.
- `empty`: the zero-action policy described above.

## Fixtures

`zero_policy.py` is the zero-action server, `check.py` validates the plan shape and `test_adapter.py`
covers planning without a GPU or a model.
