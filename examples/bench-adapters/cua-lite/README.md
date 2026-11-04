# CUA-Lite adapter

Experimental external adapter for CUA-Lite's original native BrowserGym environment. One trial is one environment and one native `agent.sample(env)` call; there is no rollout service, hub queue, database, retry or directory resume.

## Preparation

Use clean checkouts of CUA-Lite at `2af69268c0573f4c12aac391cc03125e6d5c7974` and MiniWoB++ at `7fd85d71a4b60325c6585396ec4f48377d049838`. The adapter pins BrowserGym 0.14.3. Build the client through Orbit, wait for it, then register its immutable image ID:

```sh
orbit run --dockerfile examples/bench-adapters/cua-lite/Dockerfile \
  --no-snapshot --root --cpus 1 --mem 2 --timeout 10 \
  -- python -c 'import browsergym.miniwob'
orbit wait <run>
orbit bench add cua-lite /path/to/cua-lite \
  --adapter /path/to/orbit/examples/bench-adapters/cua-lite/adapter.py \
  -c miniwob=/path/to/miniwob-plusplus -c image=sha256:<client-image-id>
orbit bench tasks cua-lite
orbit bench run cua-lite -m empty=empty -t browsergym.miniwob@click-test
```

Python 3.12 is required by the fixed CUA-Lite checkout. The Bookworm base is required by this BrowserGym version's Playwright dependency. A built image ID freezes its resolved dependencies. The checked native `lite` package and HTML corpus are mounted read-only; only caches and evidence are writable. Each container runs its own loopback HTTP server, bypassing the need for the upstream host-global MiniWoB service. It does not change the served HTML or native reward.

## Coverage and methods

All 125 registered MiniWoB tasks are listed. Missing corpus files or a prepared client image make them unsupported. WebVoyager and Online-Mind2Web tasks from the fixed checkout are listed but unsupported: this WebVoyager implementation needs its original WebHarbor replay backend, and browser-service/judge/account requirements have not been mapped and calibrated. Desktop, mobile, shared-backend and grounding suites have explicit **suite availability** rows, not fabricated individual task catalogs. KVM is checked for a clear reason, but those suites remain refused even when the device exists; KVM allocation is outside the Orbit ledger.

Observations/actions are CUA-Lite defaults: screenshots with its cursor overlay and original normalized `[0,1000]` canonical tool calls. No DOM, accessibility tree or extra BrowserGym action set is enabled. The default native step budget is 10, configurable through benchmark `maxSteps`. The trial seed goes directly to the native environment. CUA-Lite itself sets MiniWoB page timeout to 30 seconds instead of the HTML default 5 seconds; this is preserved and differs from a default BrowserGym-only run. The browser allocation defaults to 2 CPU and 4 GiB.

`empty` resets the environment then uses its original finish tool without solving; its expected MiniWoB negative calibration reward is zero. `external` can use a native CUA-Lite agent ID plus `model`; string config values are JSON-decoded where possible and passed as native keyword arguments. Model-specific native agents require their dependencies in a prepared image; the minimal image does not install every model client. Unsupported `effort`, trial options, GPU allocations and host networking are refused. Model keys use method `passEnv`.

For a custom native-compatible agent, register `-c agentDir=/path/to/module` and use `entrypoint=module:factory`. The synchronous factory receives method/seed/metadata and returns an object with `async sample(env)`. It must run exactly one episode with the supplied environment. The included `calibration_agent:make_agent` is a **scripted positive for click-test only**, selecting the button from the original screenshot. It is not an oracle for other tasks and has no privileged task-state access:

```sh
# Add -c agentDir=/path/to/orbit/examples/bench-adapters/cua-lite when registering.
orbit bench run cua-lite \
  -m scripted=external,entrypoint=calibration_agent:make_agent \
  -t browsergym.miniwob@click-test
```

Live native terminal rewards are the sole score. Missing/contradictory evidence and setup/step/model failures are invalid, never valid zero. Review includes native events/results and a saved-frame GUI trajectory; if a native terminal action supplies no screenshot, the visual prefix stops without inventing a terminal frame. The complete terminal verdict remains in native events/results. Offline verify/rescore checks identity and evidence hashes, not environment replay. External policy code is trusted; hashes are not an adversarial integrity boundary. No official aggregation is declared without denominator parity validation.

## Validation

`python3 -B -m unittest discover -s examples/bench-adapters/cua-lite` uses explicit file fixtures; real Chromium and screenshot-only calibration checks are recorded in [the task record](../../../docs/tasks/20261104-p5a-gui-hub-adapters.md).
