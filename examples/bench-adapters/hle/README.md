# Public HLE with tools

Runs the **original 2,500-question public `cais/hle` test split** with native Claude Code,
offline computation, filtered `web_search` / `web_fetch`, and an independent original-prompt judge.
This is `public-with-tools`, **not HLE-Diamond**. Upstream's current tool instructions target
HLE-Diamond; using their restrictions on the public split does not reproduce a published score.
Model, judge, CLI version, search backend and dataset are separate evaluation conditions.

## Pinned inputs

- Dataset revision: `5a81a4c7271a2a2a312b9a690f0c2fde837e4c29`.
- Original Parquet SHA-256: `6d0ee0602e8aea6b159509577e884f48ecac7b8e3f6822a35f51335a446c726a`.
- [Original HLE sources](https://github.com/centerforaisafety/hle):
  `22ed3074b1e7b134bcbc09028d0ba320839b0655`.
- Adapter checks hashes of the original blocklist, Python requirements and judge implementation.
- `prepare.py` checks the Parquet and freezes per-question JSON/images plus a separate answer index.
  Registration pins the resulting catalog; planning checks question assets and the answer index again.

Keep downloads, prepared data, credentials and results outside the source checkout. Obtain the
original Parquet through authenticated Hugging Face download if necessary. Use a Python environment
with `pyarrow` to run:

```sh
python /absolute/Orbit/examples/bench-adapters/hle/prepare.py \
  /absolute/test-00000-of-00001.parquet /absolute/prepared-hle
```

Use an empty output directory. The command prints the catalog hash needed below. Agent runs receive only the selected question
and optional image; the answer index is never mounted into the Agent or web service. The explicit
`oracle` control copies the original reference answer and is not a model performance measurement.

## Environments and registration

Build `code.Dockerfile` and `gateway.Dockerfile` through `orbit run --dockerfile`, using separate
build-context directories outside the checkout. Copy the original pinned `docs/requirements-tools.txt`
next to the code Dockerfile. The code image contains Python 3.11.16 and exactly the upstream package
pins, without specialist solvers, OCR or chess engines. The gateway image contains text extraction
and the original judge dependencies. Register immutable image IDs from `orbit show`'s `imageId`
(not the build log's config digest). Build-time download proxies must not enter evaluation containers.

Create a **dedicated** Claude Code relay auth profile whose base URL is
`http://127.0.0.1:18080`, using `orbit auth add ... --key-stdin`. Its model key is forwarded to the
configured upstream model base URL; this profile is usable only inside this adapter's loopback relay.
Keep the judge key in a user-owned, mode-0600 file; only the verifier mounts that file, read-only.
Do not put credentials in benchmark config values, method config or shell history.

```sh
orbit bench add hle-with-tools /absolute/prepared-hle \
  --adapter /absolute/Orbit/examples/bench-adapters/hle/adapter.py \
  --resources /absolute/Orbit/examples/bench-adapters/hle/resources.json \
  -c image=sha256:CODE_IMAGE_ID \
  -c gatewayImage=sha256:GATEWAY_IMAGE_ID \
  -c source=/absolute/pinned-hle-source \
  -c catalogSha256=CATALOG_HASH \
  -c judgeKeyFile=/absolute/private/judge-key \
  -c judgeBaseUrl=https://provider.example/v1 \
  -c judgeModel=YOUR_JUDGE_MODEL \
  -c modelBaseUrl=https://provider.example/anthropic
orbit bench run hle-with-tools -t QUESTION_ID -m empty -m oracle -n 'HLE judge controls'
orbit bench run hle-with-tools -t QUESTION_ID \
  -m candidate=claude-code,auth=HLE_RELAY_PROFILE,model=YOUR_MODEL -n 'HLE with tools'
```

`modelBaseUrl` is the prefix before `/v1/messages` for an Anthropic-compatible endpoint.
`judgeBaseUrl` is an OpenAI-compatible endpoint supporting structured completions.
`judgeFormat` defaults to `json_schema`. Providers without schema-mode support may explicitly use
`-c judgeFormat=json_object`: the original prompt stays unchanged, a system message requests the
original JSON schema, and the original Pydantic model strictly validates the returned JSON. This
compatibility mode is recorded in the conditions and verdict. An alternate judge is explicitly recorded and is not equivalent to upstream's default judge.
Image questions require a vision-capable model. All tasks stay visible; catalog support does not
assert that every chosen model can process images or solve every question.

## Isolation, tools and evidence

The native CLI container uses Docker `network=none`; it cannot install packages or reach the host
proxy. A read-only mounted per-run Unix socket is its sole connection to the separately networked
service. The loopback relay forwards only model messages and token-count requests to the configured
model; provider-hosted tools and other models are rejected. Computation stays in the offline image.

The two MCP tools use Bing RSS search (at most 20 candidates before filtering) and text-only fetch.
The complete pinned blocklist applies to queries, URL targets, search titles/snippets and fetched
content, including decoded proxy/archive targets and cached pages. Search-only title rules retain
their upstream scope. Long copied question spans are conservatively defined as eight consecutive
words or 50 normalized characters. Fetch checks redirects and public DNS addresses, rejects non-text
media, returns main HTML content as Markdown or extracted PDF text, and truncates at 60,000 characters.
The service caps documents at 20 MiB and web calls at 200 per trial. These are explicit implementation
conditions, not upstream backend equivalence. Tool errors are visible, never replaced by fake results.

The CLI writes `/orbit/output/answer.json` with `answer` (string) and `confidence` (integer 0..100).
Independent verification imports the hash-checked original `run_judge_results.py` and calls its
`extract_answer` function, retaining the native prompt/schema. Invalid answer format is a valid zero;
judge/API/schema errors are invalid and excluded, never silently counted as wrong answers.
Saved verdicts bind the question/catalog, judge model and response hash. `orbit bench rescore` reruns
the independent judge over saved responses; LLM judgments may vary. Final answer and verdict appear
in the trial review; the service's filtered-web audit is collected with solve evidence. Orbit reports valid-only sample
accuracy. Upstream full-set denominator and calibration-error reporting are not implemented.

## Validation

Python regression tests use explicit fixtures for isolation, source hashes, filter families, archive
URLs, SSRF rejection, cached-content checks, malformed responses and invalid judge results. The
TypeScript test passes actual adapter plans through Orbit's RunSpec and Docker argument construction.
See [development validation](../../../docs/tasks/20261116-hle-with-tools.md) for real-run scope.
Full-suite accuracy and HLE-Diamond/default-provider equivalence remain unverified.
