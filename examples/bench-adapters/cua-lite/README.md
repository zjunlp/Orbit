# CUA-Lite adapter

Experimental external adapter for CUA-Lite's original MiniWoB, WebHarbor/WebVoyager and Online-Mind2Web environments. One trial is one environment and one native `agent.sample(env)` call; there is no rollout service, hub queue, database, retry or directory resume.

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

All 125 registered MiniWoB tasks are listed. Missing corpus files or a prepared client image make them unsupported. All 643 WebVoyager and 300 Online-Mind2Web tasks are also listed; five explicitly reviewed read-only tasks per suite have an execution path, gated on a prepared original backend image. Other tasks remain unsupported with a subset reason. This is a source-reviewed eligibility subset, not a claim that the live websites or full scored Web suites have been calibrated. Desktop, mobile, shared-backend and grounding suites have explicit **suite availability** rows, not fabricated individual task catalogs. KVM is checked for a clear reason, but those suites remain refused even when the device exists; KVM allocation is outside the Orbit ledger.

Observations/actions are CUA-Lite defaults: screenshots with its cursor overlay and original normalized `[0,1000]` canonical tool calls. No DOM, accessibility tree or extra BrowserGym action set is enabled. The default native step budget is 10, configurable through benchmark `maxSteps`. The trial seed goes directly to the native environment. CUA-Lite itself sets MiniWoB page timeout to 30 seconds instead of the HTML default 5 seconds; this is preserved and differs from a default BrowserGym-only run. The browser allocation defaults to 2 CPU and 4 GiB.

`empty` resets the environment then uses its original finish tool without solving; its expected MiniWoB negative calibration reward is zero. `external` can use a native CUA-Lite agent ID plus `model`; string config values are JSON-decoded where possible and passed as native keyword arguments. Model-specific native agents require their dependencies in a prepared image; the minimal image does not install every model client. Unsupported `effort`, trial options, GPU allocations and host networking are refused. Model keys use method `passEnv`.

For a custom native-compatible agent, register `-c agentDir=/path/to/module` and use `entrypoint=module:factory`. The synchronous factory receives method/seed/metadata and returns an object with `async sample(env)`. It must run exactly one episode with the supplied environment. The included `calibration_agent:make_agent` is a **scripted positive for click-test only**, selecting the button from the original screenshot. It is not an oracle for other tasks and has no privileged task-state access:

```sh
# Add -c agentDir=/path/to/orbit/examples/bench-adapters/cua-lite when registering.
orbit bench run cua-lite \
  -m scripted=external,entrypoint=calibration_agent:make_agent \
  -t browsergym.miniwob@click-test
```

MiniWoB uses live native terminal rewards. The two Web suites use the original terminal evaluator after policy exit, as described below. Missing/contradictory evidence and setup/step/model/judge failures are invalid, never valid zero. Review includes native events/results and a saved-frame GUI trajectory; if a native terminal action supplies no screenshot, the visual prefix stops without inventing a terminal frame. The complete terminal verdict remains in native events/results and, for Web suites, `judge-result.json`. MiniWoB offline verify/rescore checks identity and evidence hashes, not environment replay. Current Orbit refuses to rescore after-phase trials, so a registration configured with a Web backend declares `rescore=none`; keep a separate MiniWoB-only registration for its evidence rescore. External policy code is trusted; hashes are not an adversarial integrity boundary. No official aggregation is declared without denominator parity validation.

## Web backends and terminal judges

Each Web trial owns one fresh native backend service, with `instances=1`; it never attaches to a shared host service. WebVoyager keeps the original WebHarbor mirror sites and their image-baked initial data on a private network. Online-Mind2Web retains the original live-site browser and outbound network. Neither service receives model or judge keys. Each service reserves 2 CPU and 4 GiB in addition to the client allocation. The native step defaults are 15 and 30 respectively (`maxSteps` overrides them); the trial seed does not freeze external website content.

Prepare each native image by copying the fixed checkout's original build context:

```sh
python3 examples/bench-adapters/cua-lite/prepare_backend.py \
  /path/to/cua-lite online_mind2web /tmp/lite-online-backend
# Run the printed `orbit run --dockerfile ...` command, then orbit wait/show its Run.
python3 examples/bench-adapters/cua-lite/prepare_backend.py \
  /path/to/cua-lite webharbor.webvoyager /tmp/lite-webvoyager-backend
# Build this printed command separately; WebHarbor includes its original site assets.
```

The helper keeps the original native build sources, adding source/suite labels and moving the original startup script from `ENTRYPOINT` to the same default `CMD`. This lets the image-build check exit; service startup still runs the original script. It refuses to overwrite an existing context. For Online-Mind2Web it also constrains the original unversioned Python installs to `playwright==1.44.0`, `fastapi==0.115.12`, `uvicorn==0.34.2` and `pydantic==2.10.6`; these versions are recorded in conditions and checked image labels. This fixes a real build failure where the unconstrained resolver selected a Python-3.12-incompatible greenlet. The pinned Playwright browser is an explicit execution condition, not a claim of equivalence to every upstream build. Other OS/package dependencies still float: the final immutable image ID is the recorded execution condition, **not** a promise of byte-reproducible future builds. Register only the resulting `sha256:...` ID (or repository digest). A normal browser image is refused.

```sh
# OPENAI_API_KEY must be available to the isolated daemon, not placed in config.
orbit bench add lite-web /path/to/cua-lite \
  --adapter /path/to/orbit/examples/bench-adapters/cua-lite/adapter.py \
  -c image=sha256:<client-image-id> \
  -c onlineMind2WebImage=sha256:<native-online-image-id> \
  -c webVoyagerImage=sha256:<native-webvoyager-image-id> \
  --pass-env OPENAI_API_KEY
orbit bench tasks lite-web
orbit bench run lite-web -m empty=empty -t webharbor.webvoyager@allrecipes.0
```

The explicit subset is defined in `web_suites.py`:

- WebVoyager: `allrecipes.0`, `.1`, `.10`, `.11`, `.12`, all read-only recipe queries in the fixed mirror corpus.
- Online-Mind2Web: `512fd4deab099b8dc0dcfc0ec48a3c63` (public GitHub issue search), `d9d8b7d84a3f8d057e368254fe8d65e2` (public GitHub commit search), `75a1b5dcd2c28508a971d98d51fe5767` (recipe reviews), `71f8de1834599fba443f40dbbfab8edd` (arXiv search), and `2207bb4f21786690cfed20b37253fb8b` (public weather lookup). Their instructions require no account; live availability can change. A navigation failure is invalid/reset_failed.

Adapter protocol 1 exposes only benchmark name/path/config, not its `passEnv` names. Consequently `tasks` can check prepared images and subset eligibility, but cannot confirm judge-key forwarding. The after phase checks the original judge dependency/key requirements and reports missing configuration as invalid/judge_unavailable; it never converts it to zero.

To keep benchmark `passEnv` out of the policy process, Web execution sets the native `skip_eval=True` only during interaction. At the terminal step it saves the **exact native evaluator buffer**, before the native agent closes its environment. Orbit's existing `after` phase then reconstructs the original evaluator and calls its original `_evaluate`, with native prompts, image selection, models (`gpt-4.1` / `o4-mini`) and verdict parsing. Online-Mind2Web image judgments run with one worker. No browser action is replayed and no grading algorithm is copied into this adapter.

This is deferred terminal grading: the policy sees no final numerical reward during `sample`, so this condition must not be mixed with methods that depend on terminal reward feedback. The original raw events keep `reward=null`; `judge-result.json` stores the native evaluator return separately, and the after phase saves `validation.json` for Orbit's score operation. WebVoyager's native no-answer return is `None` with `eval_skip_reason=no_agent_response`; its original agent accumulates only non-null rewards, yielding episode return zero. The adapter follows that specific negative-calibration convention after checking the original required judge dependencies/key. Other missing verdicts, missing keys, provider errors and incomplete captures remain invalid. A model-based positive calibration is still required before using either Web suite for reported benchmark scores.

The native evaluators can also return zero for malformed model text. The adapter preserves that raw return but marks it invalid/scorer_error when WebVoyager lacks its expected `SUCCESS`/`NOT SUCCESS` marker, Online-Mind2Web lacks `Status: success/failure`, or an Online image judgment falls outside its expected 1–5 range. This validity check does not replace the original evaluator or reinterpret a valid verdict.

## Validation

`python3 -B -m unittest discover -s examples/bench-adapters/cua-lite` uses explicit file fixtures; real Chromium and screenshot-only calibration checks are recorded in [the task record](../../../docs/tasks/20261104-p5a-gui-hub-adapters.md).

`ORBIT_LITE_NATIVE_TEST=1` additionally enables the original evaluator boundary tests, requiring Python 3.12 with the pinned source on `PYTHONPATH`. These use explicit image-buffer fixtures, check the original no-answer/key/dependency behavior, and make no model calls. They do not replace live browser or model calibration. Run them inside the prepared client with the adapter mounted at `/adapter`, the fixed `lite/` at `/upstream/lite`, its `pyproject.toml` at `/upstream/pyproject.toml`, `PYTHONPATH=/adapter:/upstream`, and `python -B -m unittest discover -s /adapter` through Orbit.
