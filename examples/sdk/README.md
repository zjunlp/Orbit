# Python SDK for benchmark adapters

Two packages that benchmark adapters and container-side drivers import. They are part of the
repository, not of the published npm package: adapters copy the parts they need into their own
image, so a change here only reaches a run after the adapter's registration is regenerated.

| Package | Used by | Purpose |
| --- | --- | --- |
| `orbit_bench` | Python adapters (`examples/bench-adapters/*/adapter.py`) | Adapter protocol 1: the `main()` entry point, request/reply JSON handling and the `valid()` / `invalid()` score replies |
| `orbit_embodied` | embodied adapter, its verifier and the native environment drivers | Container-side episode loop, bindings, evidence sealing and per-environment drivers (`libero.py`, `robotwin.py`, `calvin.py`, …) |

`orbit_embodied` imports no model or simulator at package import: drivers pull their simulator in
when a task actually runs, so the adapter can plan a trial on a host with no GPU.

## Running the tests

```bash
PYTHONPATH=examples/sdk python3 -B -m unittest discover -s examples/sdk/orbit_bench -t examples/sdk
PYTHONPATH=examples/sdk python3 -B -m unittest discover -s examples/sdk/orbit_embodied -t examples/sdk
```

`-t examples/sdk` (the top-level directory) is required: the tests import `orbit_embodied.test_core`
as a module, so discovery has to resolve the package rather than the bare directory.

### Optional dependencies

The suite is written so that the parts that need no third-party package run anywhere. Tests whose
modules need one skip or error with that import, and that is a setup problem rather than a code
defect. `docs/guides/embodied-development.md` pins the full set for a development machine.

| Package | Needed by |
| --- | --- |
| `numpy` | the drivers and most driver tests |
| `msgpack`, `msgpack-numpy` | `groot.py`, `openpi.py` wire format |
| `websockets` | `openvla.py`, `openpi.py`, `vima` policy clients |
| `pyzmq` | `groot.py` transport |
| `openpi-client` | `test_openpi.py`, from the pinned OpenPI checkout |

The adapter tests that matter for grading — planning, evidence sealing, score replies — deliberately
run with the standard library and `numpy` only, so a laptop can verify them.

## Adding a driver

Follow an existing driver's `reset` / `step` / state recording, and reuse the adapter's `tasks`,
`solve`, `verify` and `score` flow. Validate the catalog and initial-state assets first, then check
a representative task's reset, observation, a few native control steps, termination and a positive
and negative case. `docs/guides/embodied-onboarding.md` has the acceptance record to fill in.

A driver needs a test beside it. The test may use synthetic fixtures — that is expected — but it
must not claim a real simulator run it did not perform.
