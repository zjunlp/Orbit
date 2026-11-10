# AutomationBench

Runs Zapier's original `auto-bench` agent, API toolset, simulated world and rubric. The public
six-domain set (600 tasks) and `simple` set (200 tasks) are separate registrations. The official
leaderboard uses a private split; public results must not be labelled leaderboard-equivalent.

Source: [zapier/AutomationBench](https://github.com/zapier/AutomationBench), pinned to
`4a8e1061254004d9dac807054eed33fad7d1ff14` (1.0.6). Task names, instructions, initial worlds and
assertions come from the original loader. GPU is unnecessary; the supplied resource defaults allow
2 CPU, 4 GB RAM and 20 minutes per solve. Increase the timeout for slow models or full step budgets.

## Prepare and register

Keep source, catalog and results outside the Orbit checkout. From the Orbit checkout, with a pinned
upstream checkout at `$AUTOMATION_SOURCE`:

```bash
git -C "$AUTOMATION_SOURCE" checkout 4a8e1061254004d9dac807054eed33fad7d1ff14
docker build --build-context upstream="$AUTOMATION_SOURCE" \
  -t automationbench-orbit:1.0.6 \
  -f examples/bench-adapters/automationbench/Dockerfile examples/bench-adapters/automationbench
docker image inspect automationbench-orbit:1.0.6 --format '{{.Id}}'
orbit run --no-project --no-network --image automationbench-orbit:1.0.6 \
  --cpus 2 --mem 4 --timeout 5 -n 'AutomationBench catalog' -- \
  python /opt/orbit-adapter/runtime.py catalog
```

Wait for the run. Copy its `catalog.json` into a persistent user-owned directory. Register that
directory, its catalog SHA256 and the immutable image ID (retain a tag so rebuilding does not remove
an image needed by earlier jobs):

```bash
orbit bench add automationbench-public /absolute/catalog-directory \
  --adapter /absolute/Orbit/examples/bench-adapters/automationbench/adapter.py \
  --resources /absolute/Orbit/examples/bench-adapters/automationbench/resources.json \
  -c image=sha256:IMAGE_DIGEST -c catalogSha256=CATALOG_DIGEST -c split=public
```

Use a separate name and `split=simple` for the simple set. Catalog integrity and pinned upstream
contracts are checked before execution. `runtime.py` is mounted read-only from the adapter directory;
its wrappers can be fixed for rescore without modifying the original rubric in the image.

## Methods and scoring

Only `empty` and the native `external` method are supported. There is no published oracle agent.
Empty starts the original world without actions; tasks whose desired state already holds need not
score zero. Calibrate selected tasks before testing a model.

Place a method array in a user-owned JSON file:

```json
[
  {
    "name": "native-agent",
    "agent": "external",
    "entrypoint": "auto-bench",
    "model": "YOUR_MODEL",
    "config": {"baseUrl": "https://YOUR_PROVIDER/v1", "maxSteps": "50"},
    "passEnv": ["AUTOMATIONBENCH_API_KEY"]
  }
]
```

`baseUrl` is optional, and `effort` is passed as the original `--reasoning-effort`. Keep
`AUTOMATIONBENCH_API_KEY` in the daemon's environment, never in the method file. The API is called
by the benchmark's own tool agent. A lower `maxSteps` is a different evaluation budget.

```bash
orbit bench run automationbench-public -t sales.multi_hop_lookup -m empty -n 'Native empty check'
orbit bench run automationbench-public -t sales.multi_hop_lookup \
  --methods-file /absolute/methods.json -n 'Native agent sample'
```

The offline verification container reloads the pinned task and evaluates the saved final world
with `partial_credit` and `task_completed_correctly`. Strict success is the main score; assertion
credit is a separate metric. Failed APIs, unfinished tool turns with budget remaining, missing
responses and changed evidence are invalid. A completed unsuccessful workflow remains a valid zero.
The pinned CLI omits its fingerprint fields from the export; verification additionally checks its
exact original prompt, version and toolset against the frozen task. It does not invent a fingerprint
for an unrelated transcript. Native JSON and the independent rubric report are available in review.

Validation covers protocol/error cases, original empty scoring, a real native model rollout and
independent rubric parity on saved output. It does not cover every task or the private split.
