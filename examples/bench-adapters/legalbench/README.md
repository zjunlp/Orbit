# LegalBench

Adapter for [HazyResearch/legalbench](https://github.com/HazyResearch/legalbench) revision
`b46bf4ffae90524b2b72aaa30e7745fe9db64481`. Source hashes are checked before task listing and grading.

One Orbit task is one **complete original task test set**. The native `evaluation.evaluate`
function preserves balanced accuracy, numerical accuracy, extraction accuracy and F1; splitting
classification into per-question trials would change its metric. `rule_qa` requires human grading
and is explicitly unsupported. Missing datasets/prompts remain in the catalog with their reasons.

Prepare that source revision outside the Orbit checkout, then download each desired test TSV from
the official [nguha/legalbench](https://huggingface.co/datasets/nguha/legalbench) dataset repository
(`data/<task>/test.tsv`) at revision `daec8237410aa23e3faf4bc41ad8b3a7e1696826` into
`<checkout>/tasks/<task>/test.tsv`. `release.json` pins all test TSV and base prompt Git blobs.
GitHub contains training examples, not complete test sets. Follow each upstream task's data license.

```bash
orbit bench add legalbench /data/legalbench --adapter /path/to/legalbench/adapter.py \
  --resources /path/to/legalbench/resources.json
orbit bench calibrate legalbench -t hearsay -t sara_numeric \
  -t definition_extraction -t citation_prediction_open
```

Solve sees only the original `base_prompt.txt` with its fields filled for every test row, stable
row IDs and source digests. Write `$ORBIT_OUTPUT/answers.json` as `{"0":"answer", "1":"answer"}`.
The CLI batch submission scaffold is an Orbit evaluation condition, not the original model harness.
`external` executes the method's argv entrypoint with `ORBIT_TASK_FILE` and `ORBIT_METHOD_CONFIG`;
credentials use the method's `passEnv`. Reference labels appear only in `oracle` or independent verify.

Verify mounts only the saved solve outputs, private task labels and the pinned original evaluator.
It rejects data/prompt changes since solve. Missing, malformed or omitted answers become empty
predictions; scorer/import failures invalidate the evaluation. The upstream grader remains
authoritative, including its task-specific empty-answer behavior. Empty and oracle are calibration
methods, not evidence of real model performance. Rescore reruns the original evaluator.

Native scoring caveat: `sara_numeric` uses `abs(prediction / (answer + 0.1) - 1) < 0.1` after
integer parsing. No integer prediction can pass for a zero reference. The official test data has
four such rows out of 96, so reference replay scores 92/96. This task declares `oracle: partial`;
Orbit's full-score oracle check excludes it. The original formula and resulting score are retained.
The other three sampled task types pass the full-score oracle check.

The Dockerfile pins the Python base and evaluation dependencies. Default resources: 1 CPU, 2 GiB,
no GPU; solve 30 minutes, verify 5 minutes. `-c image=<prepared-image>` can use an already prepared
equivalent environment; keep its immutable image ID with validation evidence.

Run unit checks with `python3 -B -m unittest discover` in this directory. These use explicitly
synthetic fixtures, separate from real Docker calibration in the task record.
