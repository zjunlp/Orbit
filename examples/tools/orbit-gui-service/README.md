# Shared GUI service

BrowserGym and CUA-Lite adapters share one episode state machine, HTTP bridge and signed-evidence validator. Backend classes implement `spec()`, `reset()`, `step(action)` and `close()`; observations carry PNG screenshot bytes, a goal and optional text. Each backend retains its native action language, terminal reward and observation conditions.

`service.py` owns `/spec`, `/observe`, `/status`, `/act` and `/finish`, the step budget, action-id deduplication and episode cleanup. A duplicate action id returns its original result; a conflicting reuse or a new action after finish is refused. Backend request errors are recoverable without consuming a step. Real environment exceptions end the episode as an error. Finish uses the backend's original stop action and is idempotent.

`evidence.py` owns the existing `plan.json`, `trajectory.jsonl`, `screenshots/`, `result.json`, `evidence-signature.json` and `trajectory-review.json` layout. SHA-256 hashes cover evidence and Ed25519 signs the result. BrowserGym plans without a backend discriminator retain their original validation rules. CUA-Lite plans explicitly name their backend, pinned source and canonical actions, and require a native terminal verdict. This verifies recorded live evidence; it does not replay or independently regrade a task.

`adapter.py` stages the service and renders both CLI solve specs. The `gui` service runs on an internal network; only it mounts task sources, evidence and the private signing key. The main Agent gets the `orbit-computer` CLI/MCP client, joins the private GUI network and its model network, and cannot mount service evidence. Verify and score obtain the public key from the saved solve Run. The shared fixed instruction template is recorded in adapter conditions; Orbit, rather than image entrypoints, owns MCP configuration.

Validation lives with the backend adapters: run `python3 -B -m unittest discover -s examples/bench-adapters/browsergym` and the corresponding `cua-lite` command from the repository root. Unit tests use explicit fixtures; real Chromium and Agent checks are separate opt-in development validation.
