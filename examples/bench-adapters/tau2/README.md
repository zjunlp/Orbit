# τ²-bench: text user-session calibration

Direct external SDK adapter for [sierra-research/tau2-bench](https://github.com/sierra-research/tau2-bench/tree/f8de30c298689cbe0117d76a378e7315a17e5bd8),
commit `f8de30c298689cbe0117d76a378e7315a17e5bd8` (tag `v0.2.0`; its package metadata says `0.2.1-dev`).
The registered path is that upstream checkout. Harbor's tau3 converter informed the gold-action
simulation construction; no Harbor task conversion or runtime is used.

This sample implements **oracle and empty only**, with no model calls. It calibrates the environment
and offline scorer, not the quality of an agent conversing with a live simulated user.

## Declaration

| Field | Contract |
| --- | --- |
| Identity | Original airline (50) and retail (114) tasks at the commit above. Every task gets a canonical JSON SHA256 tag. All source files and the seven input/prompt files are checked against the hashes in `adapter.py`, at registration, planning and runtime. `tasks.capabilities.conditions` records the commit, source digest and each file SHA256. |
| Category | `user-session`, profiles `text`, `single-control`; subject = agent, user simulator = environment. One trial = one task conversation. No telecom, voice or dual-control. |
| Input / visibility | Native `Task`, domain policy and tool schemas. The user holds `task.user_scenario`; the agent normally sees only policy, tools and conversation. Oracle intentionally sees gold actions and required communication. No external model or CLI entrypoint is accepted. |
| Output / stop | Native `SimulationRun` messages, tool IDs, arguments, real responses and `agent_stop`. Oracle executes every gold action on a fresh domain environment and emits required communication. Empty stops immediately, retaining any initial history and executing no new actions. No synthetic user messages are invented. |
| User environment | Declared model `gpt-4.1-2025-04-14`, temperature 0, seed `trial.seed`. Prompt is upstream `UserSimulator.SYSTEM_PROMPT`, pinned `simulation_guidelines.md` and `str(task.user_scenario)`. It is formatted and saved but never invoked. This specific model is a declared future condition, not a claim of live validation. |
| Lifecycle | Dedicated Docker Run, fresh in-memory database; upstream `set_state` applies initialization data/actions/history. Verify creates its own environment and replays the saved tool trajectory. Containers are discarded by Orbit; there is no service, shared database, persistent volume or additional scheduler. |
| Resources | Each solve and verify: 1 CPU, 2 GiB memory, 0 GPUs, default 5 minutes. No devices or API quota. Allow about 2 GiB for image/build cache and 20 MiB evidence per trial; these disk figures are estimates, not enforced quotas. Solve timeout can be overridden; verify retains its own 5-minute budget. |
| Scoring | Pinned `tau2.evaluator.evaluator.evaluate_simulation`, `EvaluationType.ALL`, `solo_mode=False`. Reward is binary 0/1, higher is better. DB/action/environment assertions and this version's deterministic substring communication checks run offline. No task criteria or reward basis are rewritten. |
| Review | `simulation.json`, `context.json` (policy, schemas, user prompt, initial/final DB), `events.jsonl` (ordered native-message pointers) and `trajectory.md`; verify produces original `reward.json` and `result.json`. JSON/Markdown use existing review views; the index is not mislabelled as a GUI trajectory. |
| Trust | Calibration harness records the complete native trajectory; there is no untrusted executable method in this sample. Verify receives source/data/solve output read-only, with network disabled. It discards any saved `reward_info`, replays tool results through upstream state restoration and recomputes reward. `score` reads only the separate verifier result and checks trial identity and evidence SHA256. Solve-side scores and DB snapshots never decide reward. |
| Calibration | `oracle: max`, `empty: any`, `repeat: exact`, `seedsVary: false`. Empty can correctly receive 1 on refusal/read-only tasks with unchanged DB; retail task 0 is an explicit empty=0 boundary. Rescore rebuilds staging from the pinned checkout and saved evidence. |

At this commit, all 164 tasks default to `DB + COMMUNICATE`. Some contain **diagnostic** NL assertions
that are not part of reward. `ALL` does not invoke that judge. A task with `NL_ASSERTION` in its
reward basis is listed as `supported: false` with `judge_unavailable`; forced runtime evaluation is
also invalid. Unknown reward bases, absent criteria and dual-control actions are explicitly unsupported.

Orbit reports the valid-only per-task mean, equivalent to upstream average reward for a complete,
balanced task/seed set. Invalid trials are excluded and remain visible; missing tasks are not zeros.
The declared “official” row is explicitly the **offline subset**, not a full leaderboard result.
Upstream additionally reports `pass^k = C(successes, k) / C(trials, k)` averaged over tasks. This
cross-seed statistic is not an individual trial metric; use upstream
`tau2.metrics.agent_metrics.pass_hat_k` on complete repeated-trial groups, and report coverage if any
trial is invalid. Calibration repetition checks do not establish live-user `pass^k` performance.

## Validity

| Upstream condition | Orbit result |
| --- | --- |
| Replayed behavior fails DB, action, communication or boolean env assertion | Valid upstream reward, including 0 |
| Environment cannot initialize | `env_start` |
| Initial state/actions/history cannot be restored | `reset_failed` |
| Gold environment/tool call returns an error | `env_step`; preflight also runs for empty trials |
| Scorer throws, source/data drift, malformed/missing trajectory, changed tool result, wrong task/seed, abnormal calibration stop | `scorer_error` |
| Required NL judge | Unsupported; `judge_unavailable` if forced into runtime |
| Cancellation, timeout, OOM, image startup failure | Orbit's existing execution/evaluation/cleanup handling |

The upstream environment evaluator catches gold-action exceptions and continues. This adapter
preflights those same actions and also rejects that warning during evaluation, so infrastructure
failures cannot silently become 0 (or 1). Real model/user failures are not simulated: external
methods remain unsupported.
If a solve tool fails, the messages and tool error already observed are saved before the Run fails;
the native termination reason is `too_many_errors` and verification remains invalid.

## Build and register

Keep upstream and all runtime data outside the Orbit source checkout. From the Orbit repository:

```bash
TAU2_DATA=/absolute/path/outside/orbit/tau2-bench
git -c http.proxy=http://127.0.0.1:17890 clone https://github.com/sierra-research/tau2-bench "$TAU2_DATA"
git -C "$TAU2_DATA" checkout --detach f8de30c298689cbe0117d76a378e7315a17e5bd8
docker build --network host --build-arg HTTPS_PROXY=http://127.0.0.1:17890 \
  -t orbit-sample-tau2:v0.2.0 examples/bench-adapters/tau2
TAU2_IMAGE=$(docker image inspect orbit-sample-tau2:v0.2.0 --format '{{.Id}}')
export ORBIT_HOME=$(mktemp -d)
unset ORBIT_DATA ORBIT_PORT
node packages/orbit/src/bin.ts doctor
node packages/orbit/src/bin.ts bench add tau2 "$TAU2_DATA" \
  --adapter "$PWD/examples/bench-adapters/tau2/adapter.py" -c "image=$TAU2_IMAGE"
node packages/orbit/src/bin.ts bench coverage tau2
node packages/orbit/src/bin.ts bench calibrate tau2 --sample 4 --seeds 2
```

The default image tag is convenient; registering its content ID as above fixes the runtime image
in conditions. The Dockerfile pins Python and the directly used dependencies. Upstream code is
mounted from the validated checkout, not downloaded at runtime. No credentials or `.env` files
are mounted. Both Run phases have `network: false`.

After validation, stop this isolated daemon with `node packages/orbit/src/bin.ts daemon --stop`.
Compute the home label as the first 12 hex digits of SHA256 of the absolute `ORBIT_HOME`; check
`docker ps -a`, `docker network ls`, and `docker volume ls`, each with
`--filter label=orbit.home=<label>`. Only after all are empty, remove the temporary home.

## Tests

```bash
python3 -B -m unittest discover -s examples/bench-adapters/tau2 -p test_adapter.py -v
pnpm verify
```

Protocol tests use clearly labelled synthetic fixtures and do not require tau2 installed on the
host. Run the opt-in native tests in the image with Orbit (using the variables above):

```bash
node packages/orbit/src/bin.ts run --no-project --image "$TAU2_IMAGE" \
  --no-network --cpus 1 --mem 2 --gpus 0 --timeout 5 -n 'tau2 native adapter tests' \
  -m "$PWD/examples/bench-adapters/tau2:/adapter" -m "$PWD/examples/sdk:/sdk" \
  -m "$TAU2_DATA/src:/upstream/src" -m "$TAU2_DATA/data:/upstream/data" \
  -e TAU2_TEST_ROOT=/upstream -e TAU2_DATA_DIR=/upstream/data \
  -e PYTHONPATH=/sdk:/upstream/src -e LOGURU_LEVEL=WARNING \
  --wait -- python3 -B /adapter/test_adapter.py -v
```

These tests use the real upstream environment and cover
evaluator parity, empty/refusal boundaries, score forgery, corrupted tool output, missing evidence
and injected failures. The failure injections are explicit; no fake scorer replaces real calibration.
