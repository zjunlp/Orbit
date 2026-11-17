# longmemeval

External Orbit adapter. One trial is one complete original question/conversation.
Install the upstream checkout matching `release.json`; modified grader sources are rejected.
Keep official data outside the Orbit checkout and supply its SHA-256 explicitly.

```bash
orbit bench add longmemeval /path/to/upstream --adapter /path/to/adapter.py \
  --resources /path/to/resources.json -c data=/path/to/official-data \
  -c dataSha256=<sha256> -c judgeModel=<judge-model> -c judgeBaseUrl=<api-base> \
  --pass-env ORBIT_JUDGE_API_KEY
```

LongMemEval additionally requires `-c variant=oracle`, `s` or `m` to identify the
upstream retrieval condition. Every installed history session and timestamp is preserved;
answer/evidence labels are removed from solve inputs. HealthBench sends original messages
and keeps all rubrics private. No dataset is downloaded by an adapter operation.

Submit `codex`/`claude-code` or an external method through `orbit bench run`.
The subject writes `$ORBIT_OUTPUT/answers.json` as `{"0": "answer text"}`.
External commands receive `ORBIT_TASK_FILE=/input/task.json` and JSON `ORBIT_METHOD_CONFIG`.
Missing/malformed answers become empty responses and are still sent to the native judge.

Judge credentials must already be present in the daemon environment under the passed name;
they enter only the separate verifier. API failure is `invalid/judge_unavailable`, never zero.
API and malformed-response retries are bounded. Saved input integrity is checked on rescore.
The exact judge model/base URL are recorded in `result.json`; changing them changes the protocol.

HealthBench uses original `grade_sample` and raw per-example rubric scores, including negative
scores. Orbit's mean is raw: the official aggregate clips the mean AFTER averaging. Do not
claim the displayed raw mean is the official clipped aggregate. No full-credit oracle exists.
LongMemEval uses original `get_anscheck_prompt` and the upstream yes-substring decision.
Its reference replay is not a guaranteed oracle for abstention/preference rubric answers.
LLM judge results vary; compare identical outputs with repeat judgments before performance claims.

`test_adapter.py` uses explicit synthetic fixtures, not real model evaluation. Real validation
and remaining scope are recorded in `docs/tasks/20261116-remaining-benchmarks.md`.
