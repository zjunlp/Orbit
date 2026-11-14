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

## Token usage

`orbit show <run>` and the Run overview show session-reported token totals. Input includes cache
reads and writes; output includes reasoning. These breakdowns are already included in their totals.
Unknown fields show `Not recorded`; explicitly reported zero stays zero. Costs appear only when
recorded by the CLI, without price estimates. Embedded subagent sessions count once.

For old Runs, read the trajectory once (`orbit trajectory show <run>`) to backfill token totals, or
rebuild after changing the importer. Active previews do not persist totals.

`orbit bench usage <job...>`, `orbit bench compare <job...>`, saved reports and the Web Compare views
show usage alongside scores. Method totals include failed and prior solve attempts, deduplicate
shared batch Runs, and exclude verification Runs. Coverage such as `2/3 runs recorded` identifies
subtotals from available records. A missing breakdown in a recorded Run remains unknown in the sum.
Report entries show their selected solve Run's full usage; entries sharing a batch must not be summed.
Usage never changes scores or confidence intervals. Old saved reports remain unchanged; new reports
and rescore revisions include the available usage.

For portable ATIF packages and Chat JSONL training files, see [trajectory export](trajectory-export.md).
The unified step viewer is a separate work package.

## Environment records

GUI actions, embodied samples and conversation turns can refer to Agent steps with
`sessionStepIds`. The Run's projected session messages carry the matching `stepId`; these are
one-based ATIF step IDs, scoped to `sessionRunId`. They are not message-array positions.

```sh
orbit trajectory environment <run> gui-trajectory.json --kind gui --json
orbit trajectory environment <verify-run> conversation.json --kind conversation --session <solve-run> --json
```

The Web review pages use the same linked records. GUI actions match the operation ID and environment
step returned by the owning tool call. Conversation calls use exact IDs, or a tool name and arguments
that occur only once on both sides. Plain messages require a unique exact match of role and full text.
Ambiguous matches stay unlinked. EFE samples now save step IDs;
legacy message indexes are translated when read. Explicit step IDs take precedence.

The API is `GET /api/v1/runs/:id/environment?kind=<kind>&path=<relative-output-path>&session=<run>`.
The session Run defaults to the file's Run; select Solve for records saved by Verify. Raw downloads
remain unchanged. Preview limits are 2 MiB for GUI/episode and 16 MiB for conversation, including
worker reads. Environment-only records stay viewable; missing or damaged Agent evidence never
changes rewards or evaluation validity. `complete` means both records are available, while individual
records can still have no unique match. Subagent-local step IDs are not root-session references.

## Native ATIF from Harbor or Cua

```sh
orbit run --image <image> --trajectory native/trajectory.json -- <command>
orbit trajectory import <finished-run> native/trajectory.json --json
orbit trajectory rebuild <finished-run>
```

`--trajectory` names an ATIF file inside the Run output directory. Adapters can declare the same
source with `spec.trajectory = {"format":"atif","path":"native/trajectory.json"}`. The Cua Bench
adapter declares its native output automatically. Source selection is explicit; arbitrary JSON files
are not searched. A declared file takes precedence over native CLI sessions.

For old Runs, `trajectory import` selects a saved output file and uses the normal rebuild operation.
It requires completed cleanup, preserves a backup and remembers the successful source for later
rebuilds. It does not modify the original Run specification or output files. Existing Session, token
usage and environment views then read the imported trajectory. Import failures retain the previous
trajectory and leave evaluation results unchanged.

The importer accepts ATIF v1.5–v1.8 and preserves the source version. Unknown versions/standard fields
are rejected. Orbit adds source hashes and provenance; existing `extra.orbit` is retained under
`extra.orbit.metadata.upstream_orbit`. Child trajectories and reported metrics are preserved.

Media paths are resolved beside the source JSON and must stay under Run output. `/orbit/output/…`
paths are supported for container captures. Images and audio are copied to content-addressed local
paths; referenced bytes are checked again when rebuilding. Remote URLs must be collected locally
before import. Limits are 32 MiB per media file and 256 MiB for JSON plus media. Original native
files remain available through Outputs.
