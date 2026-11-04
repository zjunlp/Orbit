# Cua Bench adapter

Experimental external adapter for the original Cua Bench episode runner. One Orbit trial runs one native task variant. It does not use BatchRunner, upstream queues, SQLite, resume, or a parallel runner.

## Preparation

Use a clean checkout of `trycua/cua` at `2829e00b180dfb08ca5ff4cbd7c95e0a14ad3409`; the benchmark path is its `libs/cua-bench` directory. The 145 variants come from **local datasets at this commit**, not the registry `1.0` revision (`6762bcf…`). All 68 `cua-bench-basic` Linux variants are mapped. The 25 KiCad and 52 workflow variants are listed but refused until their application setup, dependencies and account requirements are mapped and calibrated.

Build the client using Orbit (from the Orbit checkout), wait for completion, and obtain its immutable image ID with `orbit show <run> --json`:

```sh
orbit run --dockerfile examples/bench-adapters/cua-bench/Dockerfile \
  --no-snapshot --root --cpus 1 --mem 2 --timeout 10 \
  -- python -c 'import cua, cua_bench, cua_sandbox'
orbit wait <run>
orbit run --image ghcr.io/trycua/bench-web@sha256:3b7e1d9d4e34694175cf1b44ffefc09b557c94b1c8f946fe50646d68df39ca87 \
  --no-project --root --cpus 1 --mem 1 --timeout 2 -- true
orbit wait <desktop-image-run>
orbit bench add cua /path/to/cua/libs/cua-bench \
  --adapter /path/to/orbit/examples/bench-adapters/cua-bench/adapter.py \
  -c image=sha256:<client-image-id>
orbit bench tasks cua
orbit bench run cua -m empty=empty -m oracle=oracle \
  -t cua-bench-basic/click-button@0
```

The Dockerfile pins the Cua SDK/client package versions; original benchmark and sandbox Python sources are mounted read-only from the checked checkout. Record the built image ID with a benchmark registration to freeze transitive dependencies. The desktop uses the original `bench-web` image digest declared by those tasks. Docker must use the `runc` default runtime; missing Docker or either prepared image makes tasks unsupported. Prepare the large desktop image before registration.

## Execution and conditions

Upstream's SDK uses Docker API calls that bypass the process executor's Docker CLI shim. This adapter instead runs the original desktop image as an Orbit service, then uses the supported `Sandbox.connect` → `RemoteDesktopSession.attach` → `run_episode(session=…)` path. It never asks the SDK to create a container.

The service retains the image's startup command, default capabilities and root user. It uses 2 CPU, 4 GiB RAM and 2 GiB `/dev/shm`, matching the upstream `min(memory/2, 2 GiB)` rule. The client requests 1 CPU and 2 GiB, in addition to the service. No KVM, extra privileges, host networking, Docker socket or upstream resource overrides are enabled. Tasks with other desktop images, operating systems or unsupported trial options are refused. Main-process resource overrides do not reduce the service allocation. Like the original sandbox-opening runner, this path passes task dimensions to `attach` but does not add desktop-resolution/background overrides; the image retains its native display defaults.

Transport uses a private per-Run network and service DNS instead of upstream's host-loopback published port; outbound access remains enabled. The original image generates its authentication token in an Orbit-owned named volume, mounted read-only into the root client. The token directory is never collected or listed in review. Orbit owns and cleans the client, service, network and volume. The adapter does not reproduce the SDK's host `oom_score_adj` lifecycle hint; Orbit owns resource limits and cleanup.

`empty` uses the original dump path; `oracle` uses each task's original solve hook. `external` accepts a native registered agent or `module:Class` entrypoint and optional `model`. `config.maxSteps` maps to native `AgentOptions.max_steps`; other config keys and `effort` are refused because this runner exposes no general agent-config channel. Register `-c agentDir=/path/to/python/module` for custom agents. Credentials use method `passEnv`, never benchmark config. Default step limit is 20 (benchmark `-c maxSteps=N`); the trial seed initializes Python/NumPy, while the native variant ID remains fixed.

Live evaluation calls the original task hook. Reward is independent of `EpisodeResult.success`: a completed evaluation can return zero or a partial reward. Setup/model/evaluator failures are invalid with a closed failure kind and `score: null`. Offline verify/rescore validates the captured native result and file hashes; it cannot replay a desktop. Native ATIF and raw episode results are review files. Native reset/post-action frames also have a GUI view; ambiguous agent trace screenshots are retained only in ATIF. No official aggregate is declared: this adapter has not established denominator parity with the upstream aggregate pipeline. Evidence hashes detect accidental changes, not malicious policy forgery; external policies remain trusted code.

## Validation

`python3 -B -m unittest discover -s examples/bench-adapters/cua-bench` uses explicit file/source fixtures. The shared TypeScript test validates the generated service plan against the real Run schema. Real-machine validation and outstanding limits are recorded in [the task record](../../../docs/tasks/20261104-p5a-gui-hub-adapters.md).
