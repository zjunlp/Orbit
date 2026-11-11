# BFCL multi-turn — tool workflow

Direct external Python SDK adapter for the **Berkeley Function Calling Leaderboard**, using
[`bfcl-eval==2026.3.23`](https://pypi.org/project/bfcl-eval/2026.3.23/) from
[Gorilla](https://github.com/ShishirPatil/gorilla/tree/main/berkeley-function-call-leaderboard).
It does not use Harbor. The four BFCL v4 multi-turn files each contain 200 conversations:
`multi_turn_base`, `multi_turn_miss_func`, `multi_turn_miss_param`, `multi_turn_long_context`.
The full catalog remains visible. `multi_turn_miss_func_49` is unsupported because its pinned
reference calls `tail` before that tool's release turn; coverage reports the reason (799/800 runnable).
The adapter does not silently remove the task or change its tool availability.

## Minimum declaration

| Field | Contract |
| --- | --- |
| Identity | BFCL multi-turn execution, package `2026.3.23`; wheel SHA-256 `3bb6dfa5f0c68ad403c9ec50b00db2bb3b4cc9b38ab1ff33f48fe30d853d3a0a`. All eight question/answer files and eight tool-schema files are pinned in [data-sha256.json](data-sha256.json), checked when read and reported in `conditions`. |
| Category | `tool-workflow`, profile `local-state`. The subject selects semantic tool calls; the scaffold manages the conversation and local upstream environments. |
| IO | One trial is one full conversation. Input: original user messages, available function schemas, previous results. Output: literal Python function calls, arguments, results and per-turn states in `evidence.json`; an empty final response is recorded (BFCL does not grade final prose). The oracle alone receives ground truth. Missing functions become available at their upstream release turn; an empty user turn denotes that tool update. |
| Methods | `oracle` executes upstream `ground_truth` in order; `empty` executes no calls in any turn (neither calls a model). CLI Agents (benchmark `requires: mcp`) hold the conversation through the `bfcl` stdio MCP server ([bfcl_mcp.py](bfcl_mcp.py)): `get_user_message` (ends the turn with the agent's reply and returns the next user turn, or `finished`), `list_functions` (schemas available in this turn; held-out functions appear at their release turn) and `call_function` (runs on the upstream instances). This is an Orbit scaffold, not BFCL's native function-calling prompt, so scores are not leaderboard-comparable. The server reads the task file from a private staging mount and deletes it, so later user turns are not on disk; ground truth never enters solve. `external` is unsupported. |
| Environment | Dedicated solve container and a separate verify container, both offline. Each conversation gets fresh upstream instances initialized with `initial_config`; no shared services, volumes, namespaces or state between trials. Import/reset is readiness; process exit stops the environment; Orbit confirms container cleanup and releases resources. |
| Resources | Each role requests 1 CPU, 1 GiB RAM, 0 GPUs, 5 minutes. Solve honors Orbit's timeout/resource overrides; verify has its own budget. No special devices or API quota. Allow about 1 GiB disk for the image, data and sampled evidence. |
| Scoring | Unmodified `multi_turn_checker` from the pinned wheel, on independently executed calls and ground truth. Checks both state after each turn and the cumulative multiset of returned tool responses. `score = int(checker.valid)`, maximum 1, higher is better. This upstream `valid` means **task correctness**, not Orbit evaluation validity. |
| Aggregation | Conversation accuracy within each category; repeated trials are samples. Infrastructure failures have no trusted score and are excluded, with missing counts shown. Combine categories only as an explicitly selected sample; this is not the overall BFCL leaderboard aggregate. Missing submissions become empty turns; malformed evidence or mismatched identity is invalid. |
| Validity | Normal tool-domain errors, unavailable tools, wrong arguments, invalid call syntax and unsuccessful states are behavior, judged using upstream checks. Missing package/version → `env_start`; initialization failure → `reset_failed`; unexpected execution errors (including upstream's swallowed exception strings) or failed fixed solve driver → `env_step`; broken reference, corrupt evidence, checker exception or missing/malformed verdict → `scorer_error`. Orbit owns timeout, cancellation, OOM and cleanup outcomes. |
| Trajectory | Solve `evidence.json`: original schemas, messages, available tools, call IDs, source, decoded name/arguments, result, action errors, initial and per-turn before/after public state. Python filesystem objects use upstream string representations; private RNG internals and file timestamps are not exported. `replay.json` contains independent verifier states/results. `verdict.json` contains upstream checker details. Verify also writes `conversation.json` (review kind `conversation`): per turn the user messages, the replayed calls and results, the agent's replies, before / after / reference states and the reference calls; the checker's first failing turn (found by running the unmodified checker on growing prefixes), later turns `unchecked`. |
| Trust | Solve evidence is self-reported. Verify accepts only call text as the proposed action sequence, regenerates results/states, and runs the original checker in fresh namespaces. It never consumes solve-written scores, verdicts, results or states as scoring authority. Its own verdict is the only score source. |
| Calibration | Default calibration expectations fit: empty = 0, oracle = 1, exact repeatability, rescore unchanged. BFCL fixture seeds are preserved; Orbit seeds label repeated runs rather than changing the question or initial state. Positive/negative, missing-tool, schema-error, malicious-expression and infrastructure-failure cases have explicit tests. |

The image uses the pinned Python base, the pinned BFCL wheel installed with `--no-deps`, and
`mpmath==1.3.0`. This is the complete dependency set for these local classes; model backends, web
search, memory, API clients and the full BFCL CLI are not used. The supported classes are
GorillaFileSystem, MathAPI, MessageAPI, TwitterAPI, TicketAPI, TradingBot, TravelAPI and
VehicleControlAPI. Their stock fixture clocks/randomness remain unchanged.

The pinned upstream `eval_runner._evaluate_single_multi_turn_entry` gates only on
`multi_turn_checker`. Its separate `multi_turn_irrelevance_checker` is saved as a diagnostic,
without changing the score. The wrapper admits only named schema tools with literal arguments;
rejected calls are recorded and omitted from executable calls. This is a restricted scaffold,
not support for arbitrary Python programs. Upstream tool implementations and checker logic are
not patched. The driver invokes upstream methods directly to preserve exception types before
the upstream executor can swallow them; results use its native encoding. Expected tool error
dictionaries stay normal responses; unexpected exceptions fail closed instead of becoming zero.
Schema type hints do not overrule values the upstream implementation accepts: for example, the
pinned references include string ticket IDs despite integer schema hints. Wrong argument binding
is a behavioral error; wrong value types that produce an upstream execution error are likewise
behavioral failures. Neither case is confused with an unexpected infrastructure exception.

## Prepare and register

Run from the Orbit checkout. Keep all downloaded data and run artifacts outside it:

```bash
BFCL_DATA=/path/outside/repo/bfcl
HTTPS_PROXY=http://127.0.0.1:17890 python3 -B \
  examples/bench-adapters/bfcl-multiturn/prepare_data.py "$BFCL_DATA"
docker build --network host --build-arg HTTPS_PROXY=http://127.0.0.1:17890 \
  -t orbit-bfcl-multiturn:2026.3.23 examples/bench-adapters/bfcl-multiturn
BFCL_IMAGE=$(docker image inspect orbit-bfcl-multiturn:2026.3.23 --format '{{.Id}}')
node packages/orbit/src/bin.ts bench add bfcl-multiturn "$BFCL_DATA" \
  --adapter "$PWD/examples/bench-adapters/bfcl-multiturn/adapter.py" \
  -c "image=$BFCL_IMAGE"
node packages/orbit/src/bin.ts bench coverage bfcl-multiturn
node packages/orbit/src/bin.ts bench calibrate bfcl-multiturn --sample 4 --seeds 2
```

The data preparation script checks the downloaded wheel and every extracted file, and refuses to
overwrite different existing data. The registered path contains `BFCL_v4_*.json`,
`possible_answer/` and `multi_turn_func_doc/`. No upstream code checkout is required.
Optional registration config `categories=multi_turn_base,multi_turn_miss_param` selects categories;
the default is all four. Unknown keys/categories fail explicitly. `image` defaults to the build
tag above; use the immutable image ID as shown to record the exact image in conditions.

For isolated development validation, export `ORBIT_HOME=$(mktemp -d)` before registration,
run `doctor`, and retain that value until cleanup. After all jobs and rescoring finish:

```bash
node packages/orbit/src/bin.ts daemon --stop
docker ps -aq --filter "label=orbit.home=$ORBIT_HOME"
docker network ls -q --filter "label=orbit.home=$ORBIT_HOME"
docker volume ls -q --filter "label=orbit.home=$ORBIT_HOME"
# Only after all three lists are empty, delete this disposable validation home.
rm -rf -- "$ORBIT_HOME"
unset ORBIT_HOME
```

## Tests

The tests contain invented fixtures rather than downloaded task data. Tests of upstream behavior
require the pinned package and fail if unavailable; injected fault doubles are explicitly named.
Use a disposable Python environment, or run the tests through Orbit in the built image with
`examples/` mounted at `/examples`:

```bash
node packages/orbit/src/bin.ts run --no-project --image "$BFCL_IMAGE" \
  --cpus 1 --mem 1 --gpus 0 --timeout 5 --no-network \
  -m "$PWD/examples:/examples" -n 'BFCL adapter tests' --wait -- \
  python3 -B -m unittest discover -s /examples/bench-adapters/bfcl-multiturn -v
pnpm verify
```

Validation results and untested scope are recorded in
[the task record](../../../docs/tasks/20261105-sample-bfcl-multiturn.md).
