import type {
  GateCheck,
  GateRecord,
  GateRecordSummary,
  MethodLine,
  ReportEntry,
} from "@zjunlp/orbit/contracts";
import { useState } from "react";
import { TopBar } from "../components/TopBar.tsx";
import { Empty, Link, Loading } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { dateTime, jobPath, runPath, trialPath } from "../lib/format.ts";
import { gatePairs, gatePath, verdictLabel } from "../lib/gates.ts";
import { setQuery, useLocation } from "../lib/router.ts";
import { useAsync } from "../lib/use.ts";
import { TrajectoryTab } from "./run/Trajectory.tsx";
import "./gates.css";

const number = (value: number | null | undefined) =>
  value == null ? "Not recorded" : Number(value.toPrecision(5)).toString();
const statusLabel = {
  pass: "Passed",
  fail: "Failed",
  insufficient: "Insufficient evidence",
  not_checked: "Not checked",
};

export function GateBadge({ record }: { record: GateRecordSummary }) {
  return (
    <Link
      className={`gate-badge ${record.mode === "calibration-aa" ? "calibration" : record.verdict.decision}`}
      href={gatePath(record.id)}
    >
      {verdictLabel(record)}
    </Link>
  );
}

export function VersionGates({ line }: { line: MethodLine }) {
  return (
    <section className="card">
      <div className="card-h">
        Version lineage and gate records <span className="spacer" />
        <Link href="/configurations/gates">All records →</Link>
      </div>
      <div className="card-b gate-lineage">
        {line.revisions.map((revision) => (
          <div key={revision.revision} className="gate-version">
            <div className="mono">
              {revision.lineage?.parent ? (
                <>{revision.lineage.parent} → </>
              ) : (
                "Root / source not declared · "
              )}
              <b>{revision.revision}</b>
            </div>
            {revision.lineage?.note && <p>{revision.lineage.note}</p>}
            <RevisionGates child={revision.revision} />
          </div>
        ))}
      </div>
    </section>
  );
}

function RevisionGates({ child }: { child: string }) {
  const records = useAsync(() => api.benchGates(child), [child], { poll: true, pollMs: 15000 });
  if (records.error) return <p className="faint">Gate records unavailable: {records.error}</p>;
  if (!records.data) return <span className="faint">Loading verdicts…</span>;
  return (
    <div className="gate-badges">
      {records.data.slice(0, 3).map((r) => (
        <span key={r.id}>
          <GateBadge record={r} />{" "}
          <small className="faint">
            {r.policy.gate.benchmark} · {r.verdict.inputs.policyDigest.slice(-8)}
          </small>
        </span>
      ))}
      {!records.data.length ? (
        <span className="faint">No gate record</span>
      ) : (
        <Link href={`/configurations/gates?child=${child}`}>History →</Link>
      )}
    </div>
  );
}

export function GatesPage() {
  const loc = useLocation();
  const child = loc.query.get("child") ?? "";
  const valid = !child || /^[a-f0-9]{12}$/.test(child);
  const records = useAsync(
    () => (valid ? api.benchGates(child || undefined) : Promise.resolve([])),
    [child, valid],
  );
  const [draft, setDraft] = useState(child);
  return (
    <>
      <TopBar
        crumbs={[{ label: "Configurations", href: "/configurations" }, { label: "Gate records" }]}
      />
      <div className="page">
        <div className="page-pad col" style={{ gap: 16 }}>
          <div>
            <h1>Evolution verdicts</h1>
            <p className="muted">
              Saved decisions, frozen policies and the evidence behind each configuration change.
            </p>
          </div>
          <form
            className="toolbar"
            onSubmit={(e) => {
              e.preventDefault();
              setQuery({ child: draft.trim() || null });
            }}
          >
            <input
              className="input"
              aria-label="Child revision"
              placeholder="Filter by 12-character child revision"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button type="submit" className="btn">
              Filter
            </button>
            <button type="button" className="btn" onClick={records.reload}>
              Refresh
            </button>
          </form>
          {!valid ? (
            <Empty title="Invalid revision">Use 12 hexadecimal characters.</Empty>
          ) : records.error ? (
            <Empty title="Could not load gate records">{records.error}</Empty>
          ) : !records.data ? (
            <Loading />
          ) : (
            <GateRecords records={records.data} />
          )}
        </div>
      </div>
    </>
  );
}

export function GateRecords({ records }: { records: GateRecordSummary[] }) {
  return (
    <>
      <p className="faint">
        Most recent {records.length} records (up to 100). Each record belongs to its own frozen
        policy. A/A records are calibration, without a promotion level.
      </p>
      {!records.length ? (
        <Empty title="No gate records yet">
          <p>
            Evaluate existing reports with{" "}
            <code>orbit bench gate --policy gate.yaml --parent PARENT --child CHILD</code>.
          </p>
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="data-table gate-table">
            <thead>
              <tr>
                <th>Verdict</th>
                <th>Parent → child</th>
                <th>Target / policy</th>
                <th>Round · α</th>
                <th>Saved</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id}>
                  <td>
                    <GateBadge record={r} />
                    {r.mode === "promotion" && r.verdict.level && (
                      <div className="faint">{r.verdict.level}</div>
                    )}
                  </td>
                  <td className="mono">
                    {r.verdict.inputs.parent} → {r.verdict.inputs.child}
                  </td>
                  <td>
                    {r.policy.gate.benchmark}
                    <div className="mono faint">{r.verdict.inputs.policyDigest.slice(-12)}</div>
                  </td>
                  <td>
                    {r.verdict.alpha.round} · {number(r.verdict.alpha.level)}
                  </td>
                  <td>
                    <Link href={gatePath(r.id)}>{dateTime(r.createdAt)}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function GatePage({ id }: { id: string }) {
  const record = useAsync(() => api.benchGateRecord(id), [id]);
  return (
    <>
      <TopBar
        crumbs={[
          { label: "Configurations", href: "/configurations" },
          { label: "Gate records", href: "/configurations/gates" },
          { label: id },
        ]}
      />
      <div className="page">
        <div className="page-pad col" style={{ gap: 18 }}>
          {record.error ? (
            <Empty title="Gate record unavailable">
              <p>{record.error}</p>
              <button type="button" className="btn" onClick={record.reload}>
                Retry
              </button>
            </Empty>
          ) : !record.data ? (
            <Loading />
          ) : (
            <GateDetail record={record.data} />
          )}
        </div>
      </div>
    </>
  );
}

export function GateDetail({ record }: { record: GateRecord }) {
  const loc = useLocation();
  const v = record.verdict;
  const selection = record.evidence.selections.find((s) => s.set === loc.query.get("set"));
  const task = loc.query.get("task");
  const issues = v.checks.filter((c) => c.required && c.status !== "pass");
  const comparison = selection && task ? gatePairs(record, selection.set, task) : [];
  const chosen = comparison.find((p) => p.sample === loc.query.get("sample")) ?? comparison[0];
  return (
    <>
      <header
        className={`gate-summary ${record.mode === "calibration-aa" ? "calibration" : v.decision}`}
      >
        <div>
          <p className="faint">
            {record.mode === "calibration-aa"
              ? "Independent A/A calibration"
              : "Configuration promotion assessment"}
          </p>
          <h1>{verdictLabel(record)}</h1>
          <p className="mono">
            {v.inputs.parent} → {v.inputs.child}
          </p>
          <p>
            {record.mode === "promotion" && v.level ? v.level : "No promotion level"} ·{" "}
            {record.policy.gate.benchmark} · {record.policy.metric}
          </p>
        </div>
        <div className="gate-budget">
          <b>Round {v.alpha.round}</b>
          <span>α = {number(v.alpha.level)}</span>
          <small>{dateTime(record.createdAt)}</small>
        </div>
      </header>
      {record.mode === "calibration-aa" && (
        <p className="gate-note">
          A/A compares independent executions of identical content. An improvement signal is a
          calibration finding, not a promoted configuration.
        </p>
      )}
      {!!issues.length && (
        <section className="card">
          <div className="card-h">
            {v.decision === "insufficient"
              ? "What evidence is missing"
              : "Checks requiring attention"}
          </div>
          <ul className="gate-issues">
            {issues.map((c) => (
              <li key={`${c.set}/${c.kind}`}>
                <b>
                  {c.set} · {statusLabel[c.status]}:
                </b>{" "}
                {c.reason}
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="gate-check-groups">
        {[
          { title: "Performance", kinds: ["improvement"] },
          { title: "Guard and transfer", kinds: ["non-inferiority"] },
          { title: "Cost", kinds: ["wall-cost", "token-cost"] },
        ].map((group) => (
          <section key={group.title} className="card">
            <div className="card-h">{group.title}</div>
            <div className="card-b">
              {v.checks
                .filter((c) => group.kinds.includes(c.kind))
                .map((c) => (
                  <Check key={`${c.set}/${c.kind}`} check={c} />
                ))}
              {!v.checks.some((c) => group.kinds.includes(c.kind)) && (
                <p className="faint">
                  {group.title === "Guard and transfer" &&
                  !record.policy.guard.length &&
                  !record.policy.final.length
                    ? "Not requested by this policy."
                    : "No result recorded for this group. See prerequisites and policy."}
                </p>
              )}
            </div>
          </section>
        ))}
      </div>
      <details className="card">
        <summary className="card-h">Prerequisites, comparability and coverage</summary>
        <div className="card-b">
          {v.checks
            .filter((c) => c.prerequisite)
            .map((c) => (
              <Check key={`${c.set}/${c.kind}`} check={c} />
            ))}
        </div>
      </details>
      <section className="card">
        <div className="card-h">Regressed tasks · {v.regressions.length}</div>
        <div className="card-b">
          {!v.regressions.length ? (
            <p className="faint">
              No threshold regressions were recorded. This alone does not establish improvement.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="data-table gate-table">
                <thead>
                  <tr>
                    <th>Set / task</th>
                    <th>Parent</th>
                    <th>Child</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {v.regressions.map((r) => (
                    <tr key={`${r.set}/${r.task}`}>
                      <td>
                        {r.set} · {r.benchmark}
                        <div className="mono">{r.task}</div>
                      </td>
                      <td>{number(r.parent)}</td>
                      <td>{number(r.child)}</td>
                      <td>
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() =>
                            setQuery({
                              set: r.set,
                              task: r.task,
                              sample: null,
                              "parent-step": null,
                              "child-step": null,
                              "parent-agent": null,
                              "child-agent": null,
                            })
                          }
                        >
                          Compare trajectories
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
      {selection && task && (
        <section className="card gate-comparison">
          <div className="card-h">
            Frozen evidence · {selection.set} · {task}
            <span className="spacer" />
            <button
              type="button"
              className="btn sm"
              onClick={() => setQuery({ set: null, task: null, sample: null })}
            >
              Close comparison
            </button>
          </div>
          {!chosen ? (
            <div className="card-b">
              No valid paired report entries are available for this task.
            </div>
          ) : (
            <>
              <div className="card-b">
                <label>
                  Paired sample{" "}
                  <select
                    className="input"
                    value={chosen.sample}
                    onChange={(e) =>
                      setQuery({
                        sample: e.target.value,
                        "parent-step": null,
                        "child-step": null,
                        "parent-agent": null,
                        "child-agent": null,
                      })
                    }
                  >
                    {comparison.map((pair) => (
                      <option key={pair.sample} value={pair.sample}>
                        {pair.sample}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="faint">
                  Uses the solve Runs frozen in these report revisions. Steps are navigated
                  independently; equal step numbers do not imply equivalent actions.
                </p>
              </div>
              <div className="gate-compare-grid">
                {(["parent", "child"] as const).map((side) => (
                  <FrozenTrajectory
                    key={`${side}/${selection.set}/${task}/${chosen.sample}`}
                    label={side}
                    entry={chosen[side]}
                    job={chosen.selection[side].job}
                    report={chosen.selection[side].revision}
                  />
                ))}
              </div>
            </>
          )}
        </section>
      )}
      <section className="card">
        <div className="card-h">Frozen report selections</div>
        <div className="card-b">
          {record.evidence.selections.map((s) => (
            <div className="gate-report" key={s.set}>
              <b>{s.set}</b>
              {(["parent", "child"] as const).map((side) => (
                <Link
                  key={side}
                  href={`${jobPath(s[side].job)}?tab=reports&report=${s[side].revision}`}
                >
                  {side}: {s[side].job} · revision {s[side].revision} · {s[side].method}
                </Link>
              ))}
            </div>
          ))}
          {!record.evidence.selections.length && <p>No complete report pair was available.</p>}
          <p className="faint">
            Source jobs may have been deleted; this saved record retains the policy and report
            evidence.
          </p>
        </div>
      </section>
      <section className="card">
        <div className="card-h">Task eligibility and leakage exclusions</div>
        <div className="card-b">
          {v.inputs.taskSets.map((s) => (
            <details key={s.set}>
              <summary>
                {s.set} · {s.benchmark} · {s.eligible} / {s.total} eligible · {s.excluded.length}{" "}
                exclusions
              </summary>
              <p className="mono">SHA-256: {s.sha256}</p>
              {s.excluded.map((e) => (
                <p key={`${e.task}/${e.trial}/${e.revision}`}>
                  {e.task} · informed by trial {e.trial} · revision {e.revision}
                </p>
              ))}
            </details>
          ))}
        </div>
      </section>
      <details className="card">
        <summary className="card-h">Frozen policy and provenance</summary>
        <div className="card-b">
          <p className="mono">{v.inputs.policyDigest}</p>
          <p>
            Evaluator: {record.evaluator} · Prior candidates: {v.inputs.priorChildren.length}
          </p>
          <p className="faint">
            The saved hash identifies this policy; it does not prove the policy was chosen before
            results were seen.
          </p>
          <pre>{JSON.stringify(record.policy, null, 2)}</pre>
          <details>
            <summary>Complete saved evidence JSON</summary>
            <a
              className="btn sm"
              href={`/api/v1/bench/gates/${encodeURIComponent(record.id)}`}
              target="_blank"
              rel="noreferrer"
            >
              Open record JSON
            </a>
          </details>
        </div>
      </details>
    </>
  );
}

function Check({ check: c }: { check: GateCheck }) {
  return (
    <div className="gate-check">
      <div>
        <b>
          {c.set} · {c.kind}
        </b>
        <span className={`gate-check-status ${c.status}`}>{statusLabel[c.status]}</span>
        {!c.required && <small>Optional</small>}
      </div>
      <p>{c.reason}</p>
      {c.diff && (
        <p>
          Paired change: {number(c.diff.mean)} · {c.diff.tasks} tasks
        </p>
      )}
      {(c.lower != null || c.upper != null) && (
        <p>
          One-sided bounds: [{number(c.lower)}, {number(c.upper)}]
        </p>
      )}
      {(c.parent != null || c.child != null) && (
        <p>
          Parent {number(c.parent)} → child {number(c.child)}
        </p>
      )}
      {c.limit != null && <small>Limit: {number(c.limit)}</small>}
    </div>
  );
}

function FrozenTrajectory({
  label,
  entry,
  job,
  report,
}: {
  label: string;
  entry: ReportEntry;
  job: string;
  report: number;
}) {
  const source = useAsync(
    () => (entry.solveRunId ? api.run(entry.solveRunId) : Promise.resolve(null)),
    [entry.solveRunId],
  );
  return (
    <div className="gate-compare-side">
      <div className="card-b">
        <b>
          {label === "parent" ? "Parent" : "Child"} · {number(entry.value)}
        </b>
        <p>
          Report revision {report} · {entry.evaluation}
        </p>
        {entry.batch && (
          <p className="faint">
            Shared solve Run · {entry.batch.size} samples. The score above belongs to this sample.
          </p>
        )}
        <Link href={`${trialPath(job, entry.trial)}?tab=session`}>Trial (current view)</Link>
        {entry.solveRunId && (
          <>
            {" "}
            · <Link href={`${runPath(entry.solveRunId)}?tab=session`}>Recorded solve Run</Link>
          </>
        )}
      </div>
      {source.error ? (
        <Empty title="Recorded solve Run unavailable">
          {source.error}. The frozen score and report remain above.
        </Empty>
      ) : source.data === undefined ? (
        <Loading />
      ) : !source.data ? (
        <Empty title="No solve Run recorded" />
      ) : (
        <TrajectoryTab key={source.data.id} run={source.data} prefix={`${label}-`} compact />
      )}
    </div>
  );
}
