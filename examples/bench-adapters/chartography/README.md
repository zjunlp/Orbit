# Chartography

Uses the original [surge-ai/chartography](https://github.com/surge-ai/chartography) loader,
Inspect `generate()` solver with the chart attached inline and no tools, and
`golden_answer_scorer` in an independent verify run. Pinned source:
`3f1bf837232d3918c2cc35c6e2418c9e70d2a57b`.

The two upstream `sample_charts` tasks are **dummy development examples**, not the released
100-task dataset. Obtain the authorized dataset from its owner and prepare its original local
manifest/YAML/image task-pack format. The adapter does not bypass access requirements or label
samples as benchmark results. Catalogs and charts stay outside the Orbit source checkout.

## Prepare

With the pinned source at `$CHARTOGRAPHY_SOURCE`, build from the Orbit checkout:

```bash
docker build --build-context upstream="$CHARTOGRAPHY_SOURCE" \
  -t chartography-orbit:pinned \
  -f examples/bench-adapters/chartography/Dockerfile examples/bench-adapters/chartography
docker image inspect chartography-orbit:pinned --format '{{.Id}}'
orbit run --no-project --no-network --image chartography-orbit:pinned \
  -m /absolute/task-pack:/pack --cpus 1 --mem 2 --timeout 5 -n 'Chartography catalog' -- \
  python /opt/orbit-adapter/runtime.py catalog
```

Copy the output `catalog.json` to a persistent user-owned directory. Register its SHA256 and the
immutable image ID; retain the image tag for earlier jobs. The catalog fingerprints the entire pack,
which is checked again in both phases.

```bash
orbit bench add chartography /absolute/catalog-directory \
  --adapter /absolute/Orbit/examples/bench-adapters/chartography/adapter.py \
  --resources /absolute/Orbit/examples/bench-adapters/chartography/resources.json \
  -c image=sha256:IMAGE_DIGEST -c catalogSha256=CATALOG_DIGEST \
  -c taskPack=/absolute/task-pack -c variant=task-pack --pass-env JUDGE_API_KEY
```

Use `variant=sample` for upstream dummy tasks. The default judge is the upstream
`google/gemini-3.5-flash`; optional `judgeModel` and `judgeBaseUrl` are explicit different evaluation
conditions. Put judge credentials in the daemon environment. A mock judge is only an explicit
failure-handling test and cannot calibrate model quality.

## Evaluation configurations and verification

Run `empty` and `oracle` first: the oracle supplies the original golden answer, and both are judged
by the original scorer. CLI agents are rejected because they would change the no-tools protocol.
Native model configurations use a user-owned JSON array:

```json
[
  {
    "name": "native-model",
    "agent": "external",
    "entrypoint": "inspect",
    "model": "openai/YOUR_VISION_MODEL",
    "config": {"baseUrl": "https://YOUR_PROVIDER/v1"},
    "passEnv": ["CHARTOGRAPHY_MODEL_API_KEY"]
  }
]
```

`baseUrl` and `effort` are optional. Use a vision-capable provider/model and keep its key in the
daemon environment. The solve container writes the response and Inspect logs. Verification reloads
the pinned sample, checks response identity, and invokes the original scorer. API failures,
malformed judge output (upstream NaN/unscored) and evidence mismatches stay invalid. The independent
verdict retains the judge's rationale. `runtime.py` is mounted read-only from the adapter directory.

The displayed metric is per-task accuracy. The official ten-epoch Pass@10 and Pass^10 reducers are
not implemented. Structural fixtures, the original dummy loader and a real vision-model/alternate-judge flow are
checked on a development sample, including empty and golden-answer controls. Invalid mock-judge
output is also rejected. Released-set and default-judge calibration remain pending.
