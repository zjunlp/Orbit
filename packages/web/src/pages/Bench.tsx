// Benchmark jobs: job list, one job's task × method matrix, and method comparison across jobs.
// Only `valid` trials enter means; invalid / unknown trials are shown with their issues.
import {
  fmtCi,
  fmtMetric,
  type MetricDef,
  metricValue,
  primaryMetric,
  resolveMetrics,
  verdict,
} from "@zjunlp/orbit/metrics";
import { useEffect, useMemo, useState } from "react";
import {
  CiBars,
  ciTitle,
  MetricSwitch,
  ScoreCell,
  StatValue,
  useMetric,
} from "../components/BenchMetrics.tsx";
import { IconAlert, IconCompare, IconFlask } from "../components/icons.tsx";
import { TopBar } from "../components/TopBar.tsx";
import { ConfirmDialog, Empty, Link, Loading, toast } from "../components/ui.tsx";
import {
  api,
  type BenchJob,
  type BenchJobList,
  type MethodSummary,
  type Trial,
} from "../lib/api.ts";
import { ago, dateTime, duration, fmtScore, jobPath, runPath, trialPath } from "../lib/format.ts";
import { navigate, onLinkClick, setQuery, useLocation } from "../lib/router.ts";
import { useAsync } from "../lib/use.ts";

const jobLabel = (j: BenchJob) => j.spec.name ?? j.id;

function JobState({ state }: { state: BenchJob["state"] }) {
  const cls = state === "done" ? "good" : state === "cancelled" ? "warn" : "";
  return <span className={`chip ${cls}`}>{state}</span>;
}

/** Stacked valid / invalid / unknown / pending bar. */
function EvalBar({ s }: { s: MethodSummary }) {
  const part = (n: number, c: string, label: string) =>
    n > 0 && (
      <span title={`${n} ${label}`} style={{ width: `${(100 * n) / s.trials}%`, background: c }} />
    );
  return (
    <div className="evalbar">
      {part(s.valid, "var(--st-succeeded)", "valid")}
      {part(s.invalid, "var(--st-failed)", "invalid")}
      {part(s.unknown, "var(--st-cancelled)", "unknown")}
      {part(s.pending, "var(--st-queued)", "pending")}
    </div>
  );
}

/** Solve resources a task ran with when the benchmark has a resources file. */
function resourceTitle(r: Record<string, number | undefined> | undefined): string | undefined {
  if (!r) return undefined;
  const parts = Object.entries(r)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  return parts.length ? `solve resources: ${parts.join(", ")}` : undefined;
}

const CLI_HINT = [
  "orbit bench add tbs /path/to/terminal-bench-science --adapter harbor",
  "orbit bench add mine /path/to/benchmark --adapter /path/to/adapter.py",
  "orbit bench run tbs -m oracle -m empty -m codex=codex,auth=<profile>,model=<model>",
];

// ---- /bench ----

export function BenchJobs() {
  const jobs = useAsync(() => api.benchJobs(), [], { poll: true, pollMs: 4000 });
  const benchmarks = useAsync(() => api.benchmarks(), []);
  const loc = useLocation();
  const selected = (loc.query.get("sel") ?? "").split(",").filter(Boolean);
  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    setQuery({ sel: next.join(",") || null });
  };

  return (
    <>
      <TopBar crumbs={[{ label: "Bench" }]}>
        <button
          type="button"
          className="btn sm"
          disabled={selected.length === 0}
          onClick={() =>
            navigate(`/bench/compare?jobs=${selected.map(encodeURIComponent).join(",")}`)
          }
        >
          <IconCompare size={14} /> Compare{selected.length ? ` (${selected.length})` : ""}
        </button>
      </TopBar>
      <div className="page">
        <div className="page-pad col" style={{ gap: 16 }}>
          {jobs.error && <div className="callout">{jobs.error}</div>}
          {!jobs.data ? (
            <Loading what="Loading bench jobs" />
          ) : jobs.data.length === 0 ? (
            <Empty title="No benchmark jobs yet" icon={<IconFlask size={36} />}>
              <p>Register a benchmark and run methods on it from the CLI:</p>
              {CLI_HINT.map((c) => (
                <p key={c}>
                  <code>{c}</code>
                </p>
              ))}
            </Empty>
          ) : (
            <section className="card">
              <div className="card-h">
                Jobs <span className="sub">{jobs.data.length}</span>
              </div>
              <JobTable jobs={jobs.data} selected={selected} toggle={toggle} />
            </section>
          )}
          <section className="card">
            <div className="card-h">
              Benchmarks <span className="sub">{benchmarks.data?.length ?? 0}</span>
            </div>
            {!benchmarks.data?.length ? (
              <div className="card-b faint">
                None registered. <code>{CLI_HINT[0]}</code>
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Adapter</th>
                    <th>Path</th>
                    <th>Resources file</th>
                    <th className="r">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {benchmarks.data.map((b) => (
                    <tr key={b.name}>
                      <td>
                        <b>{b.name}</b>
                      </td>
                      <td>
                        <span className="chip mono" title={b.adapter}>
                          {b.adapter.startsWith("/") ? b.adapter.split("/").pop() : b.adapter}
                        </span>
                      </td>
                      <td className="mono faint ellipsis">{b.path}</td>
                      <td className="mono faint ellipsis" title={b.resources}>
                        {b.resources?.split("/").pop() ?? "—"}
                      </td>
                      <td className="r faint">{ago(b.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

function JobTable({
  jobs,
  selected,
  toggle,
}: {
  jobs: BenchJobList["jobs"];
  selected: string[];
  toggle: (id: string) => void;
}) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th style={{ width: 28 }} />
          <th>Job</th>
          <th>Benchmark</th>
          <th>State</th>
          <th>Methods (primary metric ± 95% CI · valid/total)</th>
          <th className="r">Created</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => {
          const m = primaryMetric(resolveMetrics(j.metrics));
          return (
            <tr
              key={j.id}
              className={`click${selected.includes(j.id) ? " sel" : ""}`}
              onClick={() => navigate(jobPath(j.id))}
            >
              <td onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  aria-label="Select for compare"
                  checked={selected.includes(j.id)}
                  onChange={() => toggle(j.id)}
                />
              </td>
              <td>
                <Link
                  href={jobPath(j.id)}
                  style={{ color: "var(--text)", fontWeight: 600 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onLinkClick(e);
                  }}
                >
                  {jobLabel(j)}
                </Link>
                {j.spec.name && <div className="mono faint">{j.id}</div>}
                {j.folder && <div className="mono faint">{j.folder}/</div>}
              </td>
              <td>{j.spec.benchmark}</td>
              <td>
                <JobState state={j.state} />
              </td>
              <td>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <span className="faint">{m.label}</span>
                  {j.summary.map((s) => (
                    <span key={s.method} className="chip" title={summaryTitle(s)}>
                      {s.method} <b>{fmtMetric(s.metrics[m.name]?.mean, m)}</b>
                      {fmtCi(s.metrics[m.name], m) && (
                        <span className="faint">{fmtCi(s.metrics[m.name], m)}</span>
                      )}
                      <span className="faint">
                        {s.valid}/{s.trials}
                      </span>
                    </span>
                  ))}
                </div>
              </td>
              <td className="r faint">{ago(j.createdAt)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const summaryTitle = (s: MethodSummary) =>
  `${s.valid} valid · ${s.invalid} invalid · ${s.unknown} unknown · ${s.pending} pending`;

// ---- /bench/<id> ----

export function BenchJobDetail({ id }: { id: string }) {
  const [running, setRunning] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const d = useAsync(() => api.benchJob(id), [id], { poll: running, pollMs: 3000 });
  const job = d.data?.job;
  // A finished job no longer changes: stop polling it.
  useEffect(() => {
    if (job) setRunning(job.state === "running");
  }, [job]);
  const trials = d.data?.trials ?? [];
  const methods = job?.spec.methods.map((m) => m.name) ?? [];
  const tasks = useMemo(() => [...new Set(trials.map((t) => t.task))], [trials]);
  const cells = useMemo(() => {
    const m = new Map<string, Trial[]>();
    for (const t of trials) {
      const k = `${t.task}\u0000${t.method}`;
      m.set(k, [...(m.get(k) ?? []), t]);
    }
    return m;
  }, [trials]);
  const metrics = useMemo(() => resolveMetrics(job?.metrics ?? []), [job]);
  const [metric, setMetric] = useMetric(metrics);
  const problems = trials.filter(
    (t) => (t.outcome && t.outcome.evaluation !== "valid") || (t.outcome?.issues.length ?? 0) > 0,
  );

  if (d.error && !d.data)
    return (
      <>
        <TopBar crumbs={[{ label: "Bench", href: "/bench" }, { label: id }]} />
        <Empty title="Bench job not found">{d.error}</Empty>
      </>
    );
  if (!d.data || !job)
    return (
      <>
        <TopBar crumbs={[{ label: "Bench", href: "/bench" }, { label: id }]} />
        <Loading />
      </>
    );

  const cancel = async () => {
    try {
      await api.benchCancel(job.id);
      toast("Job cancelled");
      d.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const rescore = async () => {
    const n = trials.filter((t) => t.state === "done").length;
    if (
      !confirm(
        `Score the ${n} finished trial(s) of this job again? Each gets a new verify run from its saved solve output; the Agent is not rerun and earlier scores are kept.`,
      )
    )
      return;
    try {
      const r = await api.benchRescore(job.id);
      toast(
        `Rescoring ${r.trials.length} trial(s)${r.skipped.length ? `; ${r.skipped.length} skipped` : ""}`,
      );
      d.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const consolidate = async () => {
    const input = prompt(
      "Source job IDs, separated by spaces. Valid retries replace invalid trials. Consumed source jobs are deleted.",
    );
    if (input === null) return;
    const sources = input.trim().split(/\s+/).filter(Boolean);
    try {
      const appendTasks = confirm(
        "Also append new tasks, keeping their invalid results and artifacts?",
      );
      const allowTransportDifferences = confirm(
        "Allow equivalent benchmark/auth profiles that differ only in proxy or host networking?",
      );
      const body = {
        sources,
        appendTasks,
        allowTransportDifferences,
        pruneInvalid: false,
        dryRun: true,
      };
      const plan = await api.benchConsolidate(job.id, body);
      if (
        prompt(
          `Merge ${plan.adopted.length} trials, delete ${plan.removedRuns.length} obsolete runs and ${plan.removedJobs.length} source jobs? Type ${job.id} to confirm.`,
        ) !== job.id
      )
        return;
      const result = await api.benchConsolidate(job.id, { ...body, dryRun: false });
      toast(
        `Merged ${result.adopted.length} trials; ${result.leftovers.length} folders left on disk`,
      );
      d.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const end = job.endedAt ? Date.parse(job.endedAt) : Date.now();

  return (
    <>
      <TopBar crumbs={[{ label: "Bench", href: "/bench" }, { label: jobLabel(job) }]}>
        <Link className="btn sm ghost" href={`/?q=bench-${job.id}`}>
          Runs
        </Link>
        <Link className="btn sm" href={`/bench/compare?jobs=${job.id}`}>
          <IconCompare size={14} /> Compare
        </Link>
        {job.state === "running" ? (
          <button type="button" className="btn sm danger" onClick={cancel}>
            Cancel job
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn sm"
              onClick={rescore}
              title="Verify and score again from the saved solve outputs"
            >
              Rescore
            </button>
            <button type="button" className="btn sm" onClick={consolidate}>
              Merge retries
            </button>
            <button type="button" className="btn sm danger" onClick={() => setDeleting(true)}>
              Delete job
            </button>
          </>
        )}
      </TopBar>
      {deleting && (
        <ConfirmDialog
          title={`Delete bench job ${jobLabel(job)}`}
          expected={job.id}
          action="Delete this job"
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            const r = await api.benchDeleteJob(job.id);
            toast(
              `Deleted job and ${r.deleted.length} run(s)${r.leftovers.length ? `; ${r.leftovers.length} folder(s) left on disk` : ""}`,
            );
            navigate("/bench");
          }}
        >
          <p>
            This deletes the job <b>{jobLabel(job)}</b>, its {trials.length} trials and all of their
            solve and verify runs: logs, outputs, reports, Agent sessions and scores.
          </p>
        </ConfirmDialog>
      )}
      <div className="page">
        <div className="page-pad col" style={{ gap: 16 }}>
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <JobState state={job.state} />
            <span className="chip mono">{job.spec.benchmark}</span>
            {job.folder && (
              <Link className="chip link mono" href={`/?folder=${encodeURIComponent(job.folder)}`}>
                {job.folder}/
              </Link>
            )}
            <span className="faint">
              {tasks.length} tasks × {methods.length} methods × {job.spec.seeds} seed
              {job.spec.seeds > 1 ? "s" : ""} · started {dateTime(job.createdAt)} ·{" "}
              {duration(end - Date.parse(job.createdAt))}
            </span>
            {Object.entries(job.spec.options).map(([k, v]) => (
              <span key={k} className="chip mono">
                {k}={v}
              </span>
            ))}
          </div>

          <div className="stats">
            {d.data.summary.map((s) => (
              <MethodCard
                key={s.method}
                s={s}
                method={job.spec.methods.find((x) => x.name === s.method)}
                metric={metric}
                others={metrics.filter((x) => x.name !== metric.name)}
              />
            ))}
          </div>

          <section className="card">
            <div className="card-h">
              {metric.label}{" "}
              <span className="sub">
                per trial{metric.description ? ` · ${metric.description}` : ""} · click a cell for
                the trial
              </span>
              <div className="spacer" />
              <MetricSwitch metrics={metrics} value={metric} onChange={setMetric} />
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="table matrix">
                <thead>
                  <tr>
                    <th>Task</th>
                    {methods.map((m) => (
                      <th key={m}>{m}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((task) => (
                    <tr key={task}>
                      <td className="mono" title={resourceTitle(job.resources?.[task])}>
                        {task}
                      </td>
                      {methods.map((m) => (
                        <td key={m}>
                          <div className="row" style={{ gap: 4, justifyContent: "center" }}>
                            {(cells.get(`${task}\u0000${m}`) ?? []).map((t) => (
                              <TrialCell key={t.id} t={t} seeds={job.spec.seeds} metric={metric} />
                            ))}
                          </div>
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr className="mean">
                    <td>Mean over tasks</td>
                    {d.data.summary.map((s) => {
                      const st = s.metrics[metric.name] ?? null;
                      return (
                        <td key={s.method}>
                          <ScoreCell
                            value={st?.mean ?? null}
                            metric={metric}
                            evaluation={st ? "valid" : "unknown"}
                            note={fmtCi(st, metric) || undefined}
                            title={ciTitle(st, metric)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {methods.length > 1 && (
            <section className="card">
              <div className="card-h">
                Ranking <span className="sub">{metric.label} · mean over tasks</span>
              </div>
              <div className="card-b">
                <CiBars
                  metric={metric}
                  rows={d.data.summary.map((s) => ({
                    key: s.method,
                    label: s.method,
                    s: s.metrics[metric.name] ?? null,
                  }))}
                />
              </div>
            </section>
          )}

          {problems.length > 0 && (
            <section className="card">
              <div className="card-h">
                <IconAlert size={14} /> Issues <span className="sub">{problems.length} trials</span>
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Method</th>
                    <th>Evaluation</th>
                    <th>Execution</th>
                    <th>Issues</th>
                    <th>Runs</th>
                  </tr>
                </thead>
                <tbody>
                  {problems.map((t) => (
                    <tr key={t.id}>
                      <td className="mono">
                        <Link href={trialPath(t.jobId, t.id)}>{t.task}</Link>
                      </td>
                      <td>
                        {t.method}
                        {job.spec.seeds > 1 && <span className="faint"> #{t.seed}</span>}
                      </td>
                      <td>
                        <span
                          className={`chip ${t.outcome?.evaluation === "valid" ? "good" : t.outcome?.evaluation === "invalid" ? "bad" : "warn"}`}
                        >
                          {t.outcome?.evaluation}
                        </span>
                      </td>
                      <td className="mono">{t.outcome?.execution}</td>
                      <td className="muted" style={{ whiteSpace: "normal" }}>
                        {t.outcome?.issues.join("; ")}
                      </td>
                      <td>
                        <RunLinks t={t} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

/** A method's headline: the selected metric ± CI, its gap to the reference, the other metrics. */
function MethodCard({
  s,
  method,
  metric,
  others,
}: {
  s: MethodSummary;
  method: BenchJob["spec"]["methods"][number] | undefined;
  metric: MetricDef;
  others: MetricDef[];
}) {
  const st = s.metrics[metric.name] ?? null;
  const gap = st && metric.reference !== undefined ? st.mean - metric.reference : null;
  const good = gap !== null && gap !== 0 && gap > 0 === metric.higherIsBetter;
  return (
    <div className="card card-b stat" title={summaryTitle(s)}>
      <span className="l">
        <b style={{ color: "var(--text)" }}>{s.method}</b>
        {method && (
          <span className="mono">
            {" "}
            · {method.agent}
            {method.model ? ` · ${method.model}` : ""}
            {method.effort ? ` · ${method.effort}` : ""}
          </span>
        )}
      </span>
      <span className="v">
        <StatValue s={st} metric={metric} />
      </span>
      {gap !== null && (
        <span className={`l delta ${gap === 0 ? "" : good ? "up" : "down"}`}>
          {fmtMetric(gap, metric, true)} vs reference {fmtMetric(metric.reference, metric)}
        </span>
      )}
      <EvalBar s={s} />
      <span className="l">
        {s.valid} valid · {s.invalid} invalid · {s.unknown} unknown
        {s.pending ? ` · ${s.pending} pending` : ""}
      </span>
      {others.length > 0 && (
        <div className="stat-more">
          {others.map((m) => (
            <span key={m.name} title={ciTitle(s.metrics[m.name], m)}>
              {m.label} <b>{fmtMetric(s.metrics[m.name]?.mean, m)}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function RunLinks({ t }: { t: Trial }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      {t.solveRunId && (
        <Link className="chip link mono" href={runPath(t.solveRunId)}>
          solve
        </Link>
      )}
      {t.verifyRunId && (
        <Link className="chip link mono" href={runPath(t.verifyRunId)}>
          verify
        </Link>
      )}
    </span>
  );
}

function TrialCell({ t, seeds, metric }: { t: Trial; seeds: number; metric: MetricDef }) {
  const o = t.outcome;
  const phase = t.state === "done" ? null : t.history.length ? "rescoring" : t.state;
  const title = [
    `${t.task} · ${t.method}${seeds > 1 ? ` #${t.seed}` : ""}`,
    phase ? `state: ${phase}` : `evaluation: ${o?.evaluation} · execution: ${o?.execution}`,
    o && o.score !== null ? `score: ${fmtScore(o.score)} / ${fmtScore(o.maxScore)}` : null,
    ...Object.entries(o?.metrics ?? {}).map(([k, v]) => `${k}: ${fmtScore(v)}`),
    ...(o?.issues ?? t.issues),
    t.history.length
      ? `rescored; earlier: ${t.history.map((h) => fmtScore(h.outcome.score)).join(", ")}`
      : null,
    o?.cleanup === "failed" ? "cleanup failed" : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <ScoreCell
      value={metricValue(o, metric.name)}
      metric={metric}
      evaluation={o ? o.evaluation : "pending"}
      href={trialPath(t.jobId, t.id)}
      title={title}
      note={phase === "verifying" ? "verify" : seeds > 1 ? `#${t.seed}` : undefined}
    />
  );
}

// ---- /bench/compare?jobs=a,b ----

export function BenchComparePage() {
  const loc = useLocation();
  const ids = (loc.query.get("jobs") ?? "").split(",").filter(Boolean);
  const key = ids.join(",");
  const jobs = useAsync(() => api.benchJobs(), []);
  // Results change only while a selected job runs (unknown jobs count as running).
  const live = ids.some(
    (id) => (jobs.data?.find((j) => j.id === id)?.state ?? "running") === "running",
  );
  const cmp = useAsync(() => (ids.length ? api.benchCompare(ids) : Promise.resolve(null)), [key], {
    poll: live,
    pollMs: 5000,
  });
  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    setQuery({ jobs: next.join(",") || null });
  };
  const c = cmp.data;

  return (
    <>
      <TopBar crumbs={[{ label: "Bench", href: "/bench" }, { label: "Compare methods" }]} />
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
              Methods of the selected jobs are compared task by task on valid trials.
            </Empty>
          ) : cmp.error ? (
            <div className="callout">{cmp.error}</div>
          ) : !c ? (
            <Loading />
          ) : (
            <>
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
function CompareView({ c }: { c: Compare }) {
  const [metric, setMetric] = useMetric(c.metrics);
  const st = c.stats[metric.name];
  const paired = st?.pairedTasks ?? 0;
  const base = c.columns[0]?.key;
  const col = (k: string) => st?.columns[k];
  const better = (a: number, b: number) => (metric.higherIsBetter ? a > b : a < b);
  return (
    <>
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
              {c.rows.map((r) => {
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
