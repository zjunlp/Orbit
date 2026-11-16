# FinanceBench public 150 cases

Original questions, original source PDFs and human grading. This is not an LLM-judge variant.
Use the pinned source archive in `release.json`, including `data/`, `results/` and `pdfs/`.

```bash
orbit bench add financebench /path/to/financebench --adapter /path/to/adapter.py \
  --resources /path/to/resources.json -c variant=full-document
orbit bench run financebench -t financebench_id_03029 -m empty -m oracle
```

`variant=full-document` gives the subject only the question and its full original PDF at
`/documents/source.pdf`; use installed `pypdf` to read it. `variant=oracle-context` is the
paper's separate evidence-context condition and supplies annotated evidence text. These
conditions have distinct benchmark identities and must not be compared as the same protocol.
Gold answers, justifications and human labels stay private. PDF bytes are checked on rescore.

The subject writes `$ORBIT_OUTPUT/answers.json` as `{"0": "answer text"}`. External commands
receive `ORBIT_TASK_FILE` and JSON `ORBIT_METHOD_CONFIG`, with POSIX argv quoting.
`oracle` replays a published human-verified correct model completion for the selected context;
it fails explicitly when none exists. It is a reference replay, not model inference.

A verifier accepts published human labels only for the exact corresponding answer text.
Empty output receives zero. New nonempty answers require a human review and remain invalid
(`judge_unavailable`) until reviewed. No label is inferred from answer equality with gold.
The verifier exports `review-request.json`; a reviewer supplies a JSON array through
`-c humanReviews=/path/to/reviews.json`, then runs `orbit bench rescore`.
Each review requires `task`, exact `source`, `answerSha256`, a nonempty `reviewer`, and boolean
`correct`. The hash is SHA-256 of the exact UTF-8 submitted answer. Reviews for different
answers, source bytes or context conditions cannot be reused. Conflicting judgments are invalid.

Real checks use published human-labeled answers; they do not validate new model answer quality.
See `docs/tasks/20261116-remaining-benchmarks.md` for validation scope.
