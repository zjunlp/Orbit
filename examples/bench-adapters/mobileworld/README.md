# MobileWorld external adapter

Experimental integration of the original **201 task classes** at
`a026188705f4a494a12d14ddab3786a23fd2c537`. The catalog keeps every class; MCP,
user-simulator and live Chrome/Maps tasks remain unsupported. GUI-only native
apps can run once prerequisites are prepared. No native Android episode has
been calibrated on the development machine: it has no usable `/dev/kvm`.

## Preparation

Use a clean checkout of `Tongyi-MAI/MobileWorld` at the commit above and its
original `uv.lock` (`uv sync --frozen`, Python 3.12). Prepare the official
`ghcr.io/tongyi-mai/mobile_world` image and register its **digest**, not a tag.
The image must contain the original AVD snapshots and application backends.
The adapter mounts the pinned source, pyproject and lock read-only into the
original image and sets `UV_FROZEN=1`. It never substitutes a different Android
image. KVM read/write access and upstream privileged Docker requirements must
already be available; it does not change host permissions or enable software
emulation. KVM is outside Orbit's device ledger and requires host exclusivity.

```sh
orbit bench add mobileworld /absolute/MobileWorld \
  --adapter /absolute/Orbit/examples/bench-adapters/mobileworld/adapter.py \
  -c python=/absolute/MobileWorld/.venv/bin/python \
  -c image=ghcr.io/tongyi-mai/mobile_world@sha256:YOUR_PREPARED_DIGEST
orbit bench tasks mobileworld
orbit bench run mobileworld -t SetAlarmTask -m empty -n empty-calibration
```

`external.entrypoint` is a native registry name (for example `mai_ui_agent`),
with optional `model` and `config.baseUrl`. Supply `API_KEY` through the
method's `passEnv`; there is no secret-valued adapter setting or CLI flag.
Only the selected method receives model credentials. A custom Python Agent
path is deliberately not accepted yet. `empty` returns original `FINISHED`
without changing task state; the original evaluator still decides its score.
There is no official oracle. Seed is recorded for identity; the native CLI has
no task-seed argument, so this is not a claim of seeded deterministic replay.

## Execution and evidence

One process Run launches one original privileged emulator through Orbit's
Docker shim, using only its exact Run-specific container name and a loopback,
automatically allocated API port. It never discovers or reuses other devices.
The emulator receives CPU/memory limits inside the total solve request
(default 6 CPUs/12 GiB, reserving 1 CPU/2 GiB for the host runner). Orbit's
existing process cleanup owns container removal after success and cancellation.
The upstream image uses Docker-in-Docker; its internal application containers
are contained in that disposable emulator's writable filesystem.

The original `mw eval` parser and handler run exactly one task with
`max-concurrency=1`, `pass-k=1`, `auto-retry=0`, fresh output and no eval-server.
Its otherwise-hidden device-health retry is explicitly set to zero; a guard
rejects a second initialization or final evaluation. This changes recovery
policy, not task actions or scoring. All original screenshot/action/score
files remain available. The adapter validates the original HTTP score before
upstream can default a missing score to zero. Environment, Agent and evaluator
exceptions produce invalid outcomes. It does not turn missing evidence into
zero or retry a failed episode. No independent second grading call is made.

`verify` checks captured files and hashes; `rescore` revalidates saved original
scores without resetting the emulator. Native MobileWorld screenshots precede
the corresponding actions. The saved-frame GUI view therefore pairs each
next screenshot with the preceding action, leaves unmeasured per-step reward
null, and explicitly reports that the final action has no captured resulting
frame. The complete original trajectory and score remain available.

Known values named in the method `passEnv` are redacted from native text
artifacts before evidence hashes are recorded; screenshots and other binary
files are not modified.

## Validation

`python3 -B -m unittest discover -s examples/bench-adapters/mobileworld` uses
explicit file/API fixtures: catalog filtering, missing KVM, original CLI
arguments, retry/episode guards, score completeness and tamper detection.
These do **not** stand in for native emulator checks. Before treating a prepared
installation as calibrated, run at least five empty tasks, a screenshot-based
positive method, an injected environment/evaluator failure, cancellation and
labelled-resource cleanup in an isolated Orbit daemon.
