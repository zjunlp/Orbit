# Agent trajectories

Orbit saves an ATIF trajectory when a Codex or Claude Code Run finishes and cleanup confirms that
execution has stopped. The Run's Session tab uses that same trajectory; an incomplete session shows
an explicit notice. No Agent session means no trajectory.

```sh
orbit trajectory show <run>
orbit trajectory show <run> --json
orbit trajectory rebuild <run-a> <run-b>
```

`show --json` returns ATIF or `null`. Reading an old finished Run builds its trajectory on demand.
A running Run can return a preview without saving it. `rebuild` requires a finished, cleaned-up Run;
it processes all supplied IDs and exits nonzero if any rebuild fails. `--json` returns per-Run results.

Files live under `<run>/orbit/trajectory/`:

- `trajectory.json`: the current ATIF document (v1.7 output).
- `media/`: extracted images referenced by relative path.
- `trajectory.<importer>-v<version>.json`: the first saved document for that prior importer version.

Native sessions under `orbit/agent/` remain the source of truth. Rebuilding reads those files again
and retains the current document if conversion fails. Missing/empty native evidence cannot replace
an existing trajectory. Source hashes and paths relative to Agent home are recorded in `extra.orbit`.
Codex chooses the latest root rollout; Claude includes subagent files attached to the chosen session.

API clients use `GET /api/v1/runs/:id/trajectory`, `POST /api/v1/runs/:id/trajectory/rebuild`, and
`GET /api/v1/runs/:id/trajectory/files/media/<file>`. The existing `/session` endpoint projects
`SessionTranscript` from ATIF; `agentError` distinguishes unavailable evidence from no Agent session.
Remote trajectories stay on the worker and are read or rebuilt through the primary's same endpoints.

Conversion errors appear as `trajectory_error` Run events without changing execution, cleanup or
benchmark evaluation results. Fix the source/access problem and rebuild. Native JSONL reads are
limited to 256 MiB in total and local media reads to 32 MiB per file. Media sources must be inline or
inside Agent home; remote URLs are not downloaded. Trajectory strings use the Run redactor; image
pixels are retained as evidence and are not redacted.

This is the existing Session view backed by ATIF. Token summaries on Run and the unified step viewer
are separate work packages.
