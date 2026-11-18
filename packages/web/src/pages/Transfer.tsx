import type {
  TransferAssessment,
  TransferColumn,
  TransferCondition,
  TransferMatrix,
  TransferRow,
} from "@zjunlp/orbit/contracts";
import { useState } from "react";
import { TopBar } from "../components/TopBar.tsx";
import { Empty, Link, Loading } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { dateTime } from "../lib/format.ts";
import { gatePath } from "../lib/gates.ts";
import { setQuery, useLocation } from "../lib/router.ts";
import { useAsync } from "../lib/use.ts";
import "./transfer.css";

const number = (n: number) => Number(n.toPrecision(5)).toString();
const short = (digest: string) => digest.slice(-12);
const labels = {
  pass: "Checks passed",
  fail: "Checks failed",
  insufficient: "Insufficient evidence",
  missing: "Missing evidence",
  incompatible: "Incompatible conditions",
};
const roles = { gate: "Admission", guard: "Guard", final: "Final" };

export function TransferPage() {
  const { query } = useLocation();
  const parentBundle = query.get("parentBundle") ?? "";
  const childBundle = query.get("childBundle") ?? "";
  const valid =
    (!parentBundle && !childBundle) ||
    (/^[a-f0-9]{64}$/.test(parentBundle) &&
      /^[a-f0-9]{64}$/.test(childBundle) &&
      parentBundle !== childBundle);
  const key = `${parentBundle}:${childBundle}`;
  const result = useAsync(
    (signal) =>
      valid
        ? api.benchTransfer(parentBundle ? { parentBundle, childBundle } : {}, signal)
        : Promise.resolve(null),
    [key, valid],
    { resetKey: key },
  );
  return (
    <>
      <TopBar
        crumbs={[
          { label: "Configurations", href: "/configurations" },
          { label: "Transfer matrix" },
        ]}
      >
        <Link className="btn" href="/configurations/gates">
          Gate records
        </Link>
      </TopBar>
      <div className="page">
        <div className="page-pad col" style={{ gap: 16 }}>
          <div>
            <h1>Transfer evidence</h1>
            <p className="muted">
              Compare each bundle change across benchmarks and Agents. Only saved gate assessments
              appear here; unassessed evaluations leave no estimate.
            </p>
          </div>
          <TransferFilter key={key} parent={parentBundle} child={childBundle} />
          {!valid ? (
            <Empty title="Choose two bundle digests">
              <p>Enter two different, full 64-character SHA-256 digests, or clear both filters.</p>
            </Empty>
          ) : result.error ? (
            <Empty title="Transfer evidence unavailable">
              <p>{result.error}</p>
              <button type="button" className="btn" onClick={result.reload}>
                Retry
              </button>
            </Empty>
          ) : !result.data ? (
            <Loading />
          ) : (
            <TransferView
              matrix={result.data}
              rowId={query.get("change")}
              columnId={query.get("condition")}
            />
          )}
        </div>
      </div>
    </>
  );
}

function TransferFilter({ parent, child }: { parent: string; child: string }) {
  const [left, setLeft] = useState(parent);
  const [right, setRight] = useState(child);
  return (
    <form
      className="toolbar transfer-filter"
      onSubmit={(event) => {
        event.preventDefault();
        setQuery({
          parentBundle: left.trim(),
          childBundle: right.trim(),
          change: null,
          condition: null,
        });
      }}
    >
      <input
        className="input mono"
        aria-label="Parent bundle digest"
        placeholder="Parent bundle SHA-256"
        value={left}
        onChange={(e) => setLeft(e.target.value)}
      />
      <span aria-hidden="true">→</span>
      <input
        className="input mono"
        aria-label="Child bundle digest"
        placeholder="Child bundle SHA-256"
        value={right}
        onChange={(e) => setRight(e.target.value)}
      />
      <button className="btn" type="submit">
        Apply
      </button>
      <button
        className="btn"
        type="button"
        onClick={() => {
          setLeft("");
          setRight("");
          setQuery({ parentBundle: null, childBundle: null, change: null, condition: null });
        }}
      >
        Show all
      </button>
    </form>
  );
}

export function TransferView({
  matrix,
  rowId,
  columnId,
}: {
  matrix: TransferMatrix;
  rowId?: string | null;
  columnId?: string | null;
}) {
  const row = matrix.rows.find((r) => r.id === rowId);
  const column = matrix.columns.find((c) => c.id === columnId);
  const cell = row?.cells.find((c) => c.column === column?.id);
  return (
    <>
      {!matrix.rows.length ? (
        <Empty title="No saved transfer evidence">
          <p>
            Save a gate assessment with exact parent and child bundles to review the change here.
          </p>
          <Link href="/configurations/gates">Review gate records →</Link>
        </Empty>
      ) : (
        <>
          <p className="muted">
            Δ = child − parent. Intervals are descriptive 95% CIs; decisions use the saved one-sided
            tests. Versions, resources, task sets and evaluation roles stay separate. — means no
            estimate.
          </p>
          <div className="table-wrap transfer-table-wrap">
            <table className="data-table transfer-table">
              <caption className="transfer-sr">
                Bundle changes by benchmark, Agent and frozen evaluation conditions
              </caption>
              <thead>
                <tr>
                  <th scope="col">Bundle change</th>
                  {matrix.columns.map((col) => (
                    <th key={col.id} scope="col">
                      <b>{col.benchmark}</b>
                      <span>
                        {col.agent ?? "Unknown Agent"} ·{" "}
                        {col.parent?.model ?? col.child?.model ?? "Unknown model"}
                      </span>
                      <span className="faint">
                        {roles[col.role]} · {col.metric}
                      </span>
                      <span className="faint">
                        {col.parent?.version ? `v${col.parent.version}` : "Version unknown"} ·{" "}
                        {col.parent?.tasks ?? col.child?.tasks ?? "?"} tasks
                      </span>
                      <span className="mono faint" title={col.id}>
                        {short(col.id)}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.rows.map((r) => (
                  <tr key={r.id}>
                    <th scope="row" className="mono">
                      <span title={r.parentBundle}>{short(r.parentBundle)}</span>
                      <span>↓</span>
                      <span title={r.childBundle}>{short(r.childBundle)}</span>
                    </th>
                    {matrix.columns.map((col) => {
                      const value = r.cells.find((c) => c.column === col.id);
                      const assessment =
                        value?.assessments.length === 1 ? value.assessments[0] : null;
                      return (
                        <td key={col.id}>
                          {!value ? (
                            <span className="faint" role="img" aria-label="No evidence">
                              —
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="transfer-cell"
                              aria-label={`Review ${col.benchmark} ${col.agent ?? "unknown Agent"} ${roles[col.role]} for ${short(r.childBundle)}`}
                              aria-pressed={r.id === rowId && col.id === columnId}
                              onClick={() => setQuery({ change: r.id, condition: col.id })}
                            >
                              {assessment ? (
                                <>
                                  <Estimate assessment={assessment} />
                                  <span className={`transfer-status ${assessment.status}`}>
                                    {labels[assessment.status]}
                                  </span>
                                </>
                              ) : (
                                <>
                                  <b>{value.assessments.length} assessments</b>
                                  <span className="faint">Review all records →</span>
                                </>
                              )}
                            </button>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {row && column && cell ? (
        <TransferDetail row={row} column={column} assessments={cell.assessments} />
      ) : rowId || columnId ? (
        <p role="status" className="muted">
          The selected cell has no evidence in this view.
        </p>
      ) : null}
      {matrix.omitted.length > 0 && (
        <details>
          <summary>{matrix.omitted.length} records outside the matrix</summary>
          <ul>
            {matrix.omitted.map((r) => (
              <li key={r.record}>
                <Link href={gatePath(r.record)}>{r.record}</Link> ·{" "}
                {r.reason === "calibration"
                  ? "A/A calibration"
                  : r.reason === "unchanged-bundle"
                    ? "Bundle content unchanged"
                    : "Exact bundle digests unavailable"}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function Estimate({ assessment: a }: { assessment: TransferAssessment }) {
  const d = a.delta;
  if (!d)
    return (
      <span role="img" aria-label="No comparable estimate">
        —
      </span>
    );
  return (
    <>
      <b className="mono">
        Δ {d.mean > 0 ? "+" : ""}
        {number(d.mean)}
      </b>
      <span className="mono">{d.ci ? `[${d.ci.map(number).join(", ")}]` : "CI unavailable"}</span>
      <small className="faint">
        {d.tasks}/{a.eligible ?? "?"} eligible tasks paired
      </small>
    </>
  );
}

function Condition({ title, condition }: { title: string; condition: TransferCondition | null }) {
  return (
    <div className="transfer-condition">
      <b>{title}</b>
      {condition ? (
        <>
          <p>
            {condition.benchmark} · {condition.version ?? "Version unknown"}
            {condition.variant ? ` / ${condition.variant}` : ""}
          </p>
          <p>
            {condition.agent} / {condition.model ?? "Unknown model"} · effort{" "}
            {condition.effort ?? "unknown"}
          </p>
          <p>
            {condition.tasks} tasks · task set <code>{condition.taskSet ?? "unknown"}</code>
          </p>
          <p>
            Source <code>{condition.sourceCommit ?? "unknown"}</code>
          </p>
          <p>
            Condition <code>{condition.digest}</code>
          </p>
          <p>Submitted resource overrides (unknown values were not frozen):</p>
          <ul>
            {condition.budgets.map((b) => (
              <li key={JSON.stringify(b)}>
                {b.tasks} tasks · CPU {b.cpus ?? "?"} · memory {b.memGB ?? "?"} GB · GPU{" "}
                {b.gpus ?? "?"} · GPU memory {b.gpuMemGB ?? "?"} GB · timeout {b.timeoutMin ?? "?"}{" "}
                min
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted">No selected job metadata</p>
      )}
    </div>
  );
}

export function TransferDetail({
  row,
  column,
  assessments,
}: {
  row: TransferRow;
  column: TransferColumn;
  assessments: TransferAssessment[];
}) {
  const metric = column.parent?.metric ?? column.child?.metric;
  return (
    <section className="card transfer-detail" aria-label="Selected transfer evidence">
      <div className="card-h">
        {column.benchmark} · {column.agent ?? "Unknown Agent"} · {roles[column.role]}
      </div>
      <div className="card-b col" style={{ gap: 16 }}>
        <p className="mono transfer-digests">
          {row.parentBundle} → {row.childBundle}
        </p>
        <p>
          {metric?.label ?? column.metric}
          {metric?.unit
            ? ` (${metric.unit === "%" ? "percentage points for Δ" : metric.unit})`
            : ""}{" "}
          ·{" "}
          {metric ? `${metric.higherIsBetter ? "Higher" : "Lower"} is better` : "Direction unknown"}
          . Each assessment retains its own policy and decision.
        </p>
        <details>
          <summary>Frozen evaluation conditions</summary>
          <div className="transfer-conditions">
            <Condition title="Parent" condition={column.parent} />
            <Condition title="Child" condition={column.child} />
          </div>
          <p className="mono">Task file SHA-256: {column.taskFile}</p>
        </details>
        {assessments.map((a) => (
          <article className="transfer-assessment" key={`${a.record}:${a.set}`}>
            <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
              <strong className={`transfer-status ${a.status}`}>{labels[a.status]}</strong>
              <span className="faint">{dateTime(a.createdAt)}</span>
              <Link href={gatePath(a.record)}>Open saved assessment →</Link>
            </div>
            <div className="transfer-estimate">
              <Estimate assessment={a} />
            </div>
            {a.status === "incompatible" && (
              <p>
                Parent and child versions, resources or other frozen evaluation conditions do not
                match. No comparable estimate is shown.
              </p>
            )}
            {a.status === "missing" && (
              <p>The selected parent or child report is missing. No score is inferred.</p>
            )}
            <p>
              {a.excluded} learned tasks excluded · {a.eligible ?? "?"}/{a.total ?? "?"} tasks
              eligible.
            </p>
            <p>
              Whole-record decision: <b>{a.decision}</b>
              {a.level ? ` · ${a.level}` : ""}. Round {a.alpha.round} · one-sided α{" "}
              {number(a.alpha.level)}.
            </p>
            <p className="mono">Policy {a.policyDigest}</p>
            <p className="mono">
              Parent{" "}
              {a.parent
                ? `${a.parent.job}@${a.parent.revision}:${a.parent.method}`
                : "not selected"}{" "}
              · configuration {a.parentRevision}
            </p>
            <p className="mono">
              Child{" "}
              {a.child ? `${a.child.job}@${a.child.revision}:${a.child.method}` : "not selected"} ·
              configuration {a.childRevision}
            </p>
            <ul>
              {a.checks
                .filter((c) => c.status !== "pass")
                .map((c) => (
                  <li key={`${c.set}:${c.kind}:${c.reason}`}>
                    {c.kind}: {c.reason}
                  </li>
                ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
