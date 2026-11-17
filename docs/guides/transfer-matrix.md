# Transfer evidence matrix

V5 reviews **saved gate assessments** for a parent-to-child bundle change across benchmarks and
Agents. It reads the immutable E3 evidence already stored by the daemon; it does not launch an
evaluation, save a new entity, backfill reports or select the newest/best result. No model tokens
are consumed by the matrix itself.

## Open a change

In Web, open **Configurations → Transfer matrix**, or follow the transfer link on a saved gate
assessment. Leave the filters empty to see all recorded changes, or enter the two different, full
64-character bundle SHA-256 digests. These are the `basis.bundleDigest` values in the frozen job
revisions, not the 12-character configuration revisions.

```bash
orbit bench transfer --parent-bundle "$PARENT_BUNDLE" --child-bundle "$CHILD_BUNDLE"
orbit bench transfer --parent-bundle "$PARENT_BUNDLE" --child-bundle "$CHILD_BUNDLE" --json
```

Both CLI flags are required. The authenticated read-only endpoint is
`GET /api/v1/bench/transfer?parentBundle=<sha256>&childBundle=<sha256>`; omit both parameters to list
all changes. Supplying just one digest, a short digest or identical digests is an input error.

The response contains `rows`, `columns` and `omitted`. Each row holds the bundle pair and sparse
`cells`; each cell references a column and contains **all** saved `assessments`. No cell is created
for a row/column combination with no record. `delta: null` means no comparable estimate; a measured
zero remains `delta.mean: 0`. A/A calibration, unchanged bundles and records lacking exact bundle
identity are identified under `omitted`. Calibration and unresolved-identity diagnostics remain
visible when bundle filters are active.

## Read a cell

Rows are bundle changes. Columns identify a benchmark family, Agent and evaluation role
(admission, guard or final), split further by model/basis, benchmark version/variant/source,
execution conditions and resource overrides, metric, seeds/sample plan and frozen task file/set.
Different conditions never pool samples or scores. Digests identify the stored metadata; they do
not turn mutable images, missing overrides or legacy provenance into fully frozen environments.

- **One assessment:** raw paired difference `child − parent`, descriptive 95% CI and paired task
  coverage. The metric direction is shown in the detail panel; a positive difference is worse for
  a lower-is-better metric. Percent-score differences are percentage points.
- **Several assessments:** the count is shown; open the cell to review each record. They may use
  different report revisions, policies or exclusion histories. No result is selected or averaged.
- **Missing evidence / blank:** an unselected or unavailable report, or no recorded assessment for
  that combination. This is never a zero score.
- **Incompatible conditions:** the selected parent and child metadata disagree, or the saved gate
  condition check failed. The estimate is withheld, including when an older verdict had a statistic.
- **Insufficient evidence:** prerequisites, paired coverage or statistical certainty are inadequate.
  Descriptive differences may remain visible for low coverage; missing or incompatible reports and
  unresolved lineage do not supply an estimate.

The saved verdict still uses its original one-sided Student-t checks and alpha allocation, not the
normal-approximation display CI. **Checks passed/failed** describes this dataset's checks; the
**whole-record decision** may differ because another required guard or cost check failed. Optional
final results do not reverse the admission decision. A matrix is not a cross-benchmark total score
or proof of transfer.

Select a cell to inspect full bundle digests, versions, model/effort, source, task-set identity,
submitted resource overrides, policy digest, exclusion count, exact parent/child report revisions
and failure reasons. The link opens the original saved assessment and its frozen evidence, even
when live jobs have been deleted. Available trajectory links still require their original Runs.
Filters and cell selection survive reloads and can be shared through the URL.

## Evidence scope

Only E3 records created by `orbit bench gate` supply assessments. A completed evaluation that has
never been explicitly selected in a saved gate record is **not** automatically paired here. Use
[gate planning and explicit report selection](bench-gate.md) to review and save the intended
comparison. Missing second-Agent results remain missing; V5 does not run them.

V4's [prospective study helpers](evolution-study.md) retain separate experiment-level endpoint
comparisons in user-owned artifacts. Their offline analysis files are not imported as E3 gate
records. This matrix does not merge independent Orbit homes or replace the study's prospective
protocol, cost accounting or final analysis.

## Development validation

Pure projection tests cover frozen provenance, repeated/rescored assessments, metric direction,
coverage, missing evidence, multiple Agents and incompatible versions/resources. HTTP/client/CLI
checks use synthetic scores with the real Store and route handlers, including archived records
after live job deletion and no report backfill. Web rendering and browser interaction checks use
explicit synthetic evidence; they do not measure transfer effectiveness.

With the Web development server running, the interaction check is reproducible with:

```bash
ORBIT_WEB_URL=http://127.0.0.1:4187 node packages/web/test/browser/transfer.ts
```

Set `ORBIT_CHROMIUM_PATH` if the browser executable is not in Playwright's default cache. Outputs
are written to the system temporary directory, or `ORBIT_BROWSER_OUTPUT` when provided.
