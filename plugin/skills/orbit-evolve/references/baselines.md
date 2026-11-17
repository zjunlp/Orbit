# Baseline variants (V2)

Use these variants when the user requests a baseline or a comparison of evolution methods.
Otherwise the reference edit in SKILL.md remains the default. Pick the variant before reading
held-out results; do not switch after an unfavorable decision.

| Variant | Candidate construction | Decision path |
| --- | --- | --- |
| `no-change` | Exact parent bytes and executable bits | Independent A/A jobs, same revision, calibration only |
| `bounded-notes` | Append short failure lessons to AGENTS.md | V1 smoke, lineage, plan and promotion gate |
| `ace` | Reflect, then curate incremental playbook entries | Same V1 path; read [ACE](ace.md) first |

These builders edit AGENTS.md. Confirm the subject Agent actually loads that file before establishing
the common parent; do not assume every Agent reads it or add a loading wrapper midway through a
study. The host running the skill and the subject Agent being evaluated are separate choices.

## Shared comparison conditions

Start each method from the same exact parent, rather than feeding one method's candidate to the
next. Freeze the same evolve evidence, task files, policy, Agent/model/effort, auth kind, timeout,
round limits and evaluation budget. A/A needs no editing evidence. Charge each method's smokes,
invalids and retries; reserve outstanding work as in SKILL.md. Identify reused parent evaluations
and their historical cost separately, including when shared between methods. Do not sum shared
Run IDs twice in a study total. Record the editor host/model and whether its tokens are measured;
unknown editor costs prevent an all-LLM efficiency claim.

For edited variants, record the evolve export and every trial actually used for reflection or
curation, including inherited provenance, in the existing `--informed-by` lineage. No held-out
trajectory access, task-specific instructions, policy changes or score-based candidate selection.
Save proposals and reflection notes beside the user's study, outside Git and outside the candidate
bundle. These are inputs/notes; Orbit jobs and immutable gate records remain the evidence store.

## Build a bundle

Run the helper with Node.js 24.18+ (also required by Orbit):

```sh
node /installed/orbit-evolve/scripts/build-baseline.mjs /outside/request.json
```

Paths in the JSON resolve relative to the request file. Parent/base must be existing bundles with
AGENTS.md. Output must not exist, its parent directory must exist, and it must be outside the
parent/base bundles. The helper snapshots regular files, preserves their bytes and executable bits,
and rejects symlinks. Only AGENTS.md can change. It makes no model call, submits no jobs and never
writes Orbit state. For edits, AGENTS.md must be UTF-8 LF text with a trailing newline.

Limits are explicit positive integers: `changedLines` charges the entire replaced line span
(a conservative upper bound on added + deleted diff lines); `changedBytes` charges the **whole
changed AGENTS.md**, not just the suffix. These are per-round bounds. `noteLines` is the cumulative
number of appended notes since the original base, not a fresh allowance each round. The original
base and limits stay fixed for the study. Exhaustion means stop, not silently raise a limit.

The helper only enforces construction. Inspect the complete diff, then run the existing
`bench gate check-bundle` for the canonical digest, size, secret and held-out checks. Never treat
successful construction as a leakage check. Keep the bundle unchanged through submission and
retain V1's expected revision/task SHA checks. Unsupported parent formats need a separate new
prospective study; do not silently normalize the historical parent.

## No change: A/A noise control

```json
{
  "variant": "no-change",
  "parent": "/outside/parent",
  "out": "/outside/aa-copy",
  "limits": { "changedLines": 20, "changedBytes": 8192 }
}
```

Zero changed lines/bytes is correct here. Verify both canonical bundle digests and revision bases
are identical. Run two independent jobs with the same frozen tasks/seeds/conditions, or reuse one
previously selected comparable parent job and run one new independent replicate. Do not compare a
report with itself, use two rescores of one solve, add a self-parent link, invent `informedBy`, or
manufacture a different revision by changing a comment. Preserve any pre-existing lineage.

Create a separately labelled **calibration policy** with the same target tasks, metric and
thresholds, and only its gate dataset: A/A does not accept guard/final datasets. Preserve the
production promotion policy. Select the independent jobs' exact immutable reports explicitly:

```json
[
  {
    "set": "gate",
    "parent": { "job": "FIRST_JOB", "revision": 1, "method": "baseline" },
    "child": { "job": "SECOND_JOB", "revision": 1, "method": "baseline" }
  }
]
```

```sh
orbit bench gate --policy /outside/aa-policy.yaml --parent SAME_REV --child SAME_REV \
  --calibration-aa --reports /outside/aa-reports.json --json
```

`gate plan` accepts the same calibration flag and explicit report selections. Save the record even
when the decision is insufficient or reject. A statistical accept is a false-positive signal to
investigate; it never adopts a child or receives a promotion level. Small A/A samples do not prove
low noise across a benchmark. No child revision or promotion round is created.

## Bounded notes: required minimal editing baseline

Read the same valid failed evolve export as V1. For each selected failure, write a concise general
lesson tied to observed actions/feedback. Do not rewrite the original instructions, summarize away
old notes or modify skills. Combine overlapping lessons before constructing the proposal.

```json
{
  "variant": "bounded-notes",
  "base": "/outside/original-parent",
  "parent": "/outside/current-parent",
  "out": "/outside/notes-child",
  "limits": { "changedLines": 20, "changedBytes": 8192, "noteLines": 5 },
  "notes": ["Check required inputs before performing dependent actions."]
}
```

The example content illustrates the format; derive actual notes from the selected evidence.
`base` is the original common baseline, including in later rounds. The helper requires its exact
AGENTS.md prefix and all other files/modes to remain unchanged. Each note is one physical line,
rendered as `- text`; blank/control/multiline entries are rejected. Existing notes count toward the
fixed cap. An empty proposal or full allowance produces no candidate; record that and stop.

Resume SKILL.md at **Check, smoke and plan**, with all actual evidence trial IDs. Only accept adopts
the resulting child; reject/insufficient retains the current parent. Do not carry rejected notes
into the next parent. A later proposal remains bounded by the same original base and budget.
