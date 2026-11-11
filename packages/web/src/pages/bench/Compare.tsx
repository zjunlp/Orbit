import { fmtCi, fmtMetric, verdict } from "@zjunlp/orbit/metrics";
import {
  CiBars,
  ciTitle,
  MetricSwitch,
  ScoreCell,
  useMetric,
} from "../../components/BenchMetrics.tsx";
import { IconCompare } from "../../components/icons.tsx";
import { TopBar } from "../../components/TopBar.tsx";
import { Empty, Link, Loading } from "../../components/ui.tsx";
import { api } from "../../lib/api.ts";
import { jobPath } from "../../lib/format.ts";
import { setQuery, useLocation } from "../../lib/router.ts";
import { useAsync } from "../../lib/use.ts";
import { Conditions } from "./Conditions.tsx";
import { jobLabel } from "./common.tsx";
import { changedRows, withBaseline } from "./conditions.ts";
import "./workflow.css";
export function BenchComparePage() {
  const loc = useLocation();
  const ids = (loc.query.get("jobs") ?? "").split(",").filter(Boolean);
  const key = ids.join(",");
  const jobs = useAsync(() => api.benchJobs(), [], { poll: true, pollMs: 5000 });
  const cmp = useAsync(
    async () => ({ key, value: ids.length ? await api.benchCompare(ids) : null }),
    [key],
    { poll: ids.length > 0, pollMs: 5000 },
  );
  const selected = useAsync(
    () => Promise.all(ids.map((id) => api.benchJob(id).then((detail) => detail.job))),
    [key],
  );
  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    setQuery({ jobs: next.join(",") || null });
  };
  const c = cmp.data?.key === key ? cmp.data.value : null;

  return (
    <>
      <TopBar
        crumbs={[{ label: "Evaluations", href: "/bench" }, { label: "Compare configurations" }]}
      />
      <div className="page">
        <div className="page-pad col" style={{ gap: 16 }}>
          <section className="col" style={{ gap: 8 }}>
            <h3 className="section-title">Jobs</h3>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {(jobs.data ?? []).map((j) => (
                <button
                  key={j.id}
                  type="button"
                  className={`btn sm${ids.includes(j.id) ? " on" : " ghost"}`}
                  onClick={() => toggle(j.id)}
                  title={`${j.spec.benchmark} · ${j.state}`}
                >
                  {jobLabel(j)} <span className="faint">{j.spec.benchmark}</span>
                </button>
              ))}
            </div>
          </section>
          {ids.length === 0 ? (
            <Empty title="Pick jobs to compare" icon={<IconCompare size={36} />}>
              Configurations of the selected evaluations are compared task by task on valid trials.
            </Empty>
          ) : cmp.error ? (
            <div className="callout">{cmp.error}</div>
          ) : !c ? (
            <Loading />
          ) : (
            <>
              {selected.error ? (
                <div className="callout">
                  Could not load evaluation conditions: {selected.error}
                </div>
              ) : selected.data?.map((job) => job.id).join(",") === key ? (
                <Conditions jobs={selected.data} />
              ) : (
                <Loading what="Loading evaluation conditions" />
              )}
              <CompareView c={c} />
            </>
          )}
        </div>
      </div>
    </>
  );
}

type Compare = NonNullable<Awaited<ReturnType<typeof api.benchCompare>>>;

/** One metric of a comparison: task matrix, means, paired Δ to the first column, ranking bars. */
function CompareView({ c: original }: { c: Compare }) {
  const { query } = useLocation();
  const linkedBaseline = original.columns.find(
    (x) => x.jobId === query.get("baselineJob") && x.method === query.get("baselineMethod"),
  );
  const c = withBaseline(original, query.get("baseline") ?? linkedBaseline?.key ?? "");
  const [metric, setMetric] = useMetric(c.metrics);
  const st = c.stats[metric.name];
  const paired = st?.pairedTasks ?? 0;
  const base = c.columns[0]?.key;
  const col = (k: string) => st?.columns[k];
  const change = query.get("change") ?? "all";
  const target =
    c.columns.find((x) => x.key === query.get("target") && x.key !== base)?.key ??
    c.columns.find(
      (x) =>
        x.jobId === query.get("targetJob") &&
        x.method === query.get("targetMethod") &&
        x.key !== base,
    )?.key ??
    c.columns[1]?.key;
  const shown = changedRows(c, metric, base, target, change);
  const better = (a: number, b: number) => (metric.higherIsBetter ? a > b : a < b);
  return (
    <>
      <div className="bench-filters">
        <label>
          Baseline
          <select
            className="input"
            value={base ?? ""}
            onChange={(e) => setQuery({ baseline: e.target.value })}
          >
            {c.columns.map((column) => (
              <option key={column.key} value={column.key}>
                {column.key}
              </option>
            ))}
          </select>
        </label>
        {c.columns.length > 1 && (
          <>
            <label>
              Compare with
              <select
                className="input"
                value={target ?? ""}
                onChange={(e) => setQuery({ target: e.target.value })}
              >
                {c.columns
                  .filter((x) => x.key !== base)
                  .map((column) => (
                    <option key={column.key} value={column.key}>
                      {column.key}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Tasks
              <select
                className="input"
                value={change}
                onChange={(e) => setQuery({ change: e.target.value })}
              >
                {[
                  ["all", "All"],
                  ["improved", "Improved"],
                  ["regressed", "Regressed"],
                  ["unchanged", "Unchanged"],
                  ["unavailable", "No paired result"],
                ].map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <span className="faint">
          {shown.length}/{c.rows.length} tasks · filters do not change summary statistics
        </span>
      </div>
      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
        <MetricSwitch metrics={c.metrics} value={metric} onChange={setMetric} />
        <span className="faint">
          {metric.description ?? metric.label} · cells: mean over valid trials (valid/total) ·{" "}
          <b>paired</b>: the {paired} task{paired === 1 ? "" : "s"} every column has · Δ: mean
          per-task difference to <b>{base}</b> with 95% CI
        </span>
      </div>
      <section className="card">
        <div style={{ overflowX: "auto" }}>
          <table className="table matrix">
            <thead>
              <tr>
                <th>Task</th>
                {c.columns.map((x) => (
                  <th key={x.key}>
                    <Link href={jobPath(x.jobId)}>{x.key}</Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const vals = r.values[metric.name] ?? {};
                const present = Object.values(vals).filter((v): v is number => v !== null);
                const best =
                  present.length > 1 ? present.reduce((a, b) => (better(a, b) ? a : b)) : null;
                return (
                  <tr key={r.task}>
                    <td className="mono">{r.task}</td>
                    {c.columns.map((x) => {
                      const v = vals[x.key] ?? null;
                      const n = r.counts[x.key] ?? "";
                      return (
                        <td key={x.key}>
                          {n === "" ? (
                            <span className="faint">—</span>
                          ) : (
                            <ScoreCell
                              value={v}
                              metric={metric}
                              evaluation={v === null ? "unknown" : "valid"}
                              note={n}
                              href={`${jobPath(x.jobId)}?view=list&task=${encodeURIComponent(r.task)}&method=${encodeURIComponent(x.method)}`}
                              title={
                                v === null
                                  ? "no valid trial with this metric"
                                  : v === best
                                    ? "best in row"
                                    : undefined
                              }
                            />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {(["all", "paired"] as const).map((kind) => (
                <tr key={kind} className="mean">
                  <td>{kind === "all" ? "Mean (all tasks)" : `Mean (paired, ${paired})`}</td>
                  {c.columns.map((x) => {
                    const s = col(x.key)?.[kind] ?? null;
                    return (
                      <td key={x.key}>
                        <ScoreCell
                          value={s?.mean ?? null}
                          metric={metric}
                          evaluation={s ? "valid" : "unknown"}
                          note={fmtCi(s, metric) || undefined}
                          title={ciTitle(s, metric)}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr className="mean">
                <td>Δ vs {base} (paired)</td>
                {c.columns.map((x, i) => {
                  const d = col(x.key)?.diff ?? null;
                  if (i === 0 || !d)
                    return (
                      <td key={x.key} className="faint">
                        {i === 0 ? "baseline" : "—"}
                      </td>
                    );
                  const v = verdict(d, metric);
                  return (
                    <td key={x.key} title={ciTitle(d, metric)}>
                      <span className={`mono delta ${v > 0 ? "up" : v < 0 ? "down" : ""}`}>
                        {fmtMetric(d.mean, metric, true)} <small>{fmtCi(d, metric)}</small>
                      </span>
                      <div className="faint" style={{ fontSize: 11 }}>
                        {v === 0 ? "not significant" : v > 0 ? "better" : "worse"}
                      </div>
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-h">
          Ranking{" "}
          <span className="sub">
            {metric.label} · {paired > 0 ? `paired tasks (${paired})` : "all tasks"}
          </span>
        </div>
        <div className="card-b">
          <CiBars
            metric={metric}
            rows={c.columns.map((x) => ({
              key: x.key,
              label: x.key,
              href: jobPath(x.jobId),
              s: (paired > 0 ? col(x.key)?.paired : col(x.key)?.all) ?? null,
            }))}
          />
        </div>
      </section>
    </>
  );
}
