# Export Agent trajectories

Export saved Agent evidence as portable ATIF packages or Chat JSONL. The daemon writes the files;
`--out` is a directory on its host, including when the CLI connects from another machine.

```sh
orbit trajectory export --job <job> --tasks-file evolve.txt --method baseline --valid-only --format atif --out /path/new-export
orbit trajectory export --trial <trial> --format chat-jsonl --out /path/new-chat
orbit trajectory export --run <run> --reasoning none --out /path/new-export --json
```

Choose exactly one selector category (`--run`, `--trial` or `--job`); repeat that flag to select
multiple IDs. Trial/job selectors use the currently selected solve Runs. `--run` can also select
standalone, verification or retained prior execution Runs. Their manifest contexts refer to that
execution's scoring, including old verification revisions, rather than a later retry's outcome.
Missing configuration revisions remain `null`; approximate revisions are identified explicitly.

`--tasks-file` contains UTF-8 task IDs, one per line; blank lines are ignored and an empty file is
rejected. `--method` is repeatable. `--valid-only` requires a valid evaluation. `--outcome pass`
means a valid, recorded score at least `maxScore`; `fail` means a valid score below `maxScore`.
Both require positive `maxScore`. Invalid/unknown evaluations and missing scores never become
failure samples. Filters intersect. An empty selection fails rather than producing an empty dataset.

All selected Runs must have ended with confirmed cleanup and have an Agent trajectory. Shared batch
Runs are exported once, with all selected trial contexts in the manifest. If the selection excludes
any trial sharing that Run, export fails: a complete Agent conversation cannot safely be sliced into
episodes using only task metadata. Select the whole batch or use separate Runs to preserve data splits.

## Files and integrity

ATIF output:

```text
manifest.json
runs/1/trajectory.json
runs/1/media/<sha256>.<extension>
runs/2/trajectory.json
```

Chat JSONL output has `dataset.jsonl` instead of the per-Run `trajectory.json` files. Each line is one
root or embedded subagent conversation, with `run`, `trajectory_id`, `parent_trajectory_id`, `tools`
and `messages`. Step IDs remain scoped to their own trajectory. Full messages and tool results are
retained without the Session viewer's truncation. Tool calls use function names, JSON-string arguments
and original IDs; results use the same `tool_call_id`. Unbound observations use user messages marked
`observation: true`; missing results are not fabricated. Inspect incomplete sessions before training.

Multimodal content uses ATIF text/image/audio parts. Media paths in Chat rows are relative to the export
root (`runs/1/media/…`); ATIF paths are relative to each `trajectory.json`. This is Orbit's portable
training interchange format, not a promise that every provider accepts the file without adaptation.
Tool definitions are preserved only when the source recorded them.

The versioned manifest records selection/filter settings, exporter version, Run execution and cleanup,
trial task/method/configuration revision/sample, independent evaluation validity and score, full-session
token totals, trajectory completeness and each payload file's SHA-256 and byte length. It does not
hash itself. Unknown token fields stay unknown; reasoning policy does not change reported usage. Numbered directories avoid
using untrusted IDs as file paths. The license notice reminds consumers to check upstream benchmark
and model-content licenses before redistribution.

The destination must not exist, its parent must exist, and it must be outside Orbit's home and data
roots. Files are private (0600), directories are 0700. Data is staged beside the destination and
published after validation. Errors discard staging and do not publish a partial export. Limits are
1000 Runs, 1 GiB per export and 32 MiB per media file. Referenced media must have safe local paths
and match their content hashes. Worker evidence uses the existing trajectory/media API; no remote
URLs are fetched. External subagent files must be embedded before exporting; continuation references
remain provenance rather than automatic requests to export another session.

## Reasoning and secrets

`--reasoning summary` is the default: only explicitly identified summaries are included. `raw` also
includes raw/untagged standard `reasoning_content`; `none` removes that field. Encrypted/opaque
reasoning and native thought signatures are excluded in every mode. Arbitrary native reasoning
metadata is removed rather than interpreted as a public summary. Source evidence is unchanged.

Known credentials pass through Orbit's existing redactor. A second scan checks text, metadata,
tool arguments, manifest and media bytes for common key/token/private-key/password patterns. Any
remaining hit fails with a location and does not echo the suspected value. Media containing a known
credential fails rather than being corrupted by text substitution. Image pixels and audio are not
OCR/transcribed or semantically redacted; inspect content before sharing. Pattern checks cannot
identify every possible secret or confidential benchmark passage.

API: `POST /api/v1/trajectory/export`, using the shared `TrajectoryExportRequest` contract. Typed
CLI and Web clients expose the same operation; this package adds no export screen or training service.
The existing `orbit export <folder> <destination>` continues to copy whole record directories.
