# OSWorld-V2 external adapter

Experimental integration of the **108 original `osworld-v2.1` release tasks**,
using code `d9953673daf55381237e058fd9388cc2d74c5538`. The task catalog comes
from the release's verified hash manifest, even when gated task files are
absent. This is implemented code with file/SDK fixture coverage; **native VM
calibration has not run** on the development machine because KVM and the
gated task/assets snapshots are unavailable.

## Preparation

Prepare the clean pinned OSWorld-V2 checkout and original `uv.lock`
dependencies with `uv sync --frozen` (Python 3.12+). The Docker SDK must be
`7.1.0`; the adapter rejects other SDK versions. Obtain access to the
upstream gated Hugging Face tasks/assets using the project's documented
process. Credentials never belong in Orbit config or the repository.

The manifest binds task revision `0a1aadad95aa79b00b3783e717d865089ab06e26`,
assets revision `384b3834faba5700a7b589e6cc181490c9808949`, the original Ubuntu
VM archive and Docker runtime digest. Use unmodified task files; every file
must match the main repository's release hash manifest. For assets this
adapter currently requires a clean Git checkout at the pinned revision with
LFS objects materialized; arbitrary folders and mutable HTTP roots are not
accepted as release identity. The original release download utility can
supply task files, but its assets folder alone is insufficient for this check.

Prepare the manifest's `osworld-v2-ubuntu-x86.qcow2.zip` and Docker runtime
image in advance. The adapter does not download gated resources or silently
accept another image. It hashes the complete archive inside the leased solve
Run and extracts its sole qcow2 into private trial staging, then mounts it
read-only as the original provider does. Allow enough data disk space for
that extracted VM; the archive remains user-owned and untouched.

```sh
orbit bench add osworld-v2 /absolute/OSWorld-V2 \
  --adapter /absolute/Orbit/examples/bench-adapters/osworld-v2/adapter.py \
  -c python=/absolute/OSWorld-V2/.venv/bin/python \
  -c tasksDir=/absolute/release-task-classes \
  -c assetsDir=/absolute/pinned-assets-git-checkout \
  -c vmArchive=/absolute/osworld-v2-ubuntu-x86.qcow2.zip
orbit bench tasks osworld-v2
```

Readable/writable `/dev/kvm` is mandatory. KVM is not in Orbit's device ledger
and requires host exclusivity. The adapter never enables upstream software
emulation. Missing prerequisites and tasks needing proxy credentials,
user simulators, alternate providers/platforms or multiple phases are listed
with explicit unsupported reasons. These conditions are checked again before
creating the VM; no task is silently dropped from the release catalog.

## Execution and methods

One process Run uses the original `DesktopEnv` and `run_single_example`, with
original screenshot observations and `pyautogui` actions, with the original
`run.py` default of 15 decision steps. `empty` returns
native `DONE` without changing task state; the original evaluator decides its
score. `external.entrypoint=prompt-agent` selects the original `PromptAgent`,
with `model` and optional non-secret `config.temperature`, `topP`, `maxTokens`.
Model credentials use method `passEnv`. No model baseline is claimed here.
Seed is retained in trial identity; the native runner has no task-seed
argument, so this is not deterministic replay.

The original Docker provider uses the Python SDK rather than `docker` CLI.
A small per-process guard wraps SDK container **creation**, validates the
exact runtime digest, read-only VM disk, KVM and original guest CPU/RAM, then
adds `orbit.parent` and delegates to the original SDK. Both its `run` and
`create` paths pass through this guard; a second VM or different creation
arguments are refused. Orbit's existing process cleanup removes the labelled
VM and releases the lease. No alternate store or cleanup loop is introduced.
Ports bind to host loopback instead of all interfaces. The guest remains
4 CPUs/4 GiB; the container and host runner fit the default total 5 CPU/8 GiB
request. This is an explicit resource/network adaptation.

The native setup replay count is set to one, and second resets/evaluations
are refused. Checkpoint evaluation and multi-phase tasks are not enabled.
The original 60-second post-reset settling delay is preserved. Missing
agent-created files remain native zero-score method failures; the fixed
upstream metric-exception/no-evaluator branches are observed separately and
classified invalid. Non-finite/missing scores, setup, action and propagated
evaluator failures are invalid, not zero. Original `result.txt`, optional
`result.json`, screenshots, recordings and `traj.jsonl` are retained.
The saved-frame GUI view captures the first screenshot actually supplied to
Agent `predict` as frame zero, without an extra observation or reset. Later
frames use original post-action screenshots; actions between captured frames
are grouped and any missing final frame is stated explicitly.
`verify`/`rescore` validate captured evidence and hashes without regrading.
The adapter does not claim that every custom task's internal exception
handling has been calibrated before its gated source and real VM are tested.

Known values named in the method `passEnv` are redacted from native text
artifacts before evidence hashes are recorded; screenshots and other binary
files are not modified.

## Validation

`python3 -B -m unittest discover -s examples/bench-adapters/osworld-v2` covers
explicit fixtures for release hashes/filtering, absent prerequisites, owned
single-VM creation, CPU/RAM/port restrictions, forbidden alternate images or
devices, archive integrity, swallowed evaluator errors and saved scores.
With `docker==7.1.0`, the suite also exercises the actual SDK `run`/`create`
contract against a mocked low-level API. Set `OSWORLD_CHECKOUT` to the pinned
source to exercise the unchanged original single-task functions and results
logger with an explicit environment fixture. Neither check starts a VM.
Native empty (at least five tasks), positive,
failure, cancellation and cleanup checks remain required on a prepared KVM
host before using scores as a calibrated benchmark result.
