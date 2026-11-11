import { resolveMetrics } from "@zjunlp/orbit/metrics";
import { useEffect, useMemo, useRef, useState } from "react";
import { CiBars, useMetric } from "../../components/BenchMetrics.tsx";
import { IconCompare } from "../../components/icons.tsx";
import { TopBar } from "../../components/TopBar.tsx";
import { ConfirmDialog, Empty, Link, Loading, toast } from "../../components/ui.tsx";
import { api } from "../../lib/api.ts";
import { dateTime, duration } from "../../lib/format.ts";
import { navigate, useLocation } from "../../lib/router.ts";
import { useAsync } from "../../lib/use.ts";
import { Conditions } from "./Conditions.tsx";
import { ConsolidateDialog } from "./ConsolidateDialog.tsx";
import { JobState, jobLabel } from "./common.tsx";
import { TrialBrowser } from "./TrialBrowser.tsx";
import "./workflow.css";
import { MethodCard } from "./MethodCard.tsx";
export function BenchJobDetail({ id }: { id: string }) {
  const [deleting, setDeleting] = useState(false);
  const [merging, setMerging] = useState(false);
  const d = useAsync(() => api.benchJob(id), [id], { poll: true, pollMs: 5000 });
  const job = d.data?.job;
  const trials = d.data?.trials ?? [];
  const methods = job?.spec.methods.map((m) => m.name) ?? [];
  const tasks = useMemo(() => [...new Set(trials.map((t) => t.task))], [trials]);
  const metrics = useMemo(() => resolveMetrics(job?.metrics ?? []), [job]);
  const [metric, setMetric] = useMetric(metrics);

  if (d.error && !d.data)
    return (
      <>
        <TopBar crumbs={[{ label: "Evaluations", href: "/bench" }, { label: id }]} />
        <Empty title="Bench job not found">{d.error}</Empty>
      </>
    );
  if (!d.data || !job)
    return (
      <>
        <TopBar crumbs={[{ label: "Evaluations", href: "/bench" }, { label: id }]} />
        <Loading />
      </>
    );

  const evidence = job.capabilities?.rescore === "evidence";
  const active = trials.filter((t) => t.state !== "done").length;
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
        `${evidence ? "Recheck saved evidence for" : "Rescore"} ${n} finished trial(s)? Each gets a new verify run from saved solve output. The Agent is not rerun; earlier results remain in history.`,
      )
    )
      return;
    try {
      const r = await api.benchRescore(job.id);
      toast(
        `Verifying ${r.trials.length} trial(s)${r.skipped.length ? `; ${r.skipped.length} skipped` : ""}`,
      );
      d.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const end = job.endedAt ? Date.parse(job.endedAt) : Date.now();

  return (
    <>
      <TopBar
        className="topbar-wrap"
        crumbs={[{ label: "Evaluations", href: "/bench" }, { label: jobLabel(job) }]}
      >
        <Link className="btn sm ghost" href={`/runs?q=bench-${job.id}`}>
          Runs
        </Link>
        <Link className="btn sm" href={`/bench/compare?jobs=${job.id}`}>
          <IconCompare size={14} /> Compare
        </Link>
        <Link className="btn sm" href={`/bench/new?from=${encodeURIComponent(job.id)}`}>
          Copy and create
        </Link>
        {job.state === "running" ? (
          <button type="button" className="btn sm danger" onClick={cancel}>
            Cancel job
          </button>
        ) : (
          <>
            {job.capabilities?.rescore !== "none" && (
              <button
                type="button"
                className="btn sm"
                onClick={rescore}
                disabled={active > 0}
                title="Verify and score again from the saved solve outputs"
              >
                {evidence ? "Recheck evidence" : "Rescore"}
              </button>
            )}
            <details className="bench-more">
              <summary className="btn sm">More</summary>
              <div className="bench-more-actions">
                <button
                  type="button"
                  className="btn sm"
                  disabled={active > 0}
                  onClick={() => setMerging(true)}
                >
                  Merge retries
                </button>
                <button
                  type="button"
                  className="btn sm danger"
                  disabled={active > 0}
                  onClick={() => setDeleting(true)}
                >
                  Delete job
                </button>
              </div>
            </details>
          </>
        )}
      </TopBar>
      {merging && (
        <ConsolidateDialog key={id} id={id} onClose={() => setMerging(false)} onMerged={d.reload} />
      )}
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
          <h1 className="page-title">{jobLabel(job)}</h1>
          <div className="row" style={{ gap: 10, flexWrap: "wrap", marginTop: -8 }}>
            <JobState state={job.state} />
            <span className="chip mono">{job.spec.benchmark}</span>
            {job.folder && (
              <Link className="chip link mono" href={`/?folder=${encodeURIComponent(job.folder)}`}>
                {job.folder}/
              </Link>
            )}
            <span className="faint">
              {job.spec.samplePlan
                ? `${job.spec.samplePlan.items.length} samples × ${methods.length} configurations`
                : `${tasks.length} tasks × ${methods.length} configurations × ${job.spec.seeds} seeds`}{" "}
              · started {dateTime(job.createdAt)} · {duration(end - Date.parse(job.createdAt))}
            </span>
            {Object.entries(job.spec.options).map(([k, v]) => (
              <span key={k} className="chip mono">
                {k}={v}
              </span>
            ))}
          </div>

          {d.error && <div className="callout">{d.error}</div>}
          <div className="card card-b bench-progress">
            <span>
              {trials.length - active}/{trials.length} trials finished
            </span>
            <progress
              max={trials.length || 1}
              value={trials.length - active}
              aria-label="Evaluation progress"
            />
            <span className="faint">
              {trials.filter((t) => t.state === "pending").length} queued ·{" "}
              {trials.filter((t) => t.state === "solving").length} solving ·{" "}
              {trials.filter((t) => t.state === "verifying").length} verifying
            </span>
            {job.state !== "running" && active > 0 && (
              <span className="chip">Rechecking saved output</span>
            )}
          </div>
          <Conditions jobs={[job]} />
          <div className="stats">
            {d.data.summary.map((s) => (
              <MethodCard
                key={s.method}
                s={s}
                method={job.spec.methods.find((x) => x.name === s.method)}
                metric={metric}
                others={metrics.filter((x) => x.name !== metric.name)}
                official={job.official}
              />
            ))}
          </div>

          {job.state !== "running" && <Reports id={job.id} version={trials.length - active} />}

          <TrialBrowser
            job={job}
            trials={trials}
            summary={d.data.summary}
            metric={metric}
            metrics={metrics}
            setMetric={setMetric}
          />

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
        </div>
      </div>
    </>
  );
}

/**
 * Report revisions (design §9.7): each is an immutable record of the plan, the attempts used and
 * both views. A rescore or merge adds one; earlier ones stay.
 */
function Reports({ id, version }: { id: string; version: number }) {
  const r = useAsync(() => api.benchReports(id), [id, version]);
  const loc = useLocation();
  const selected = Number(loc.query.get("report")) || null;
  const container = useRef<HTMLDetailsElement>(null);
  const reports = r.data ?? [];
  useEffect(() => {
    if (selected && r.data) container.current?.scrollIntoView({ block: "start" });
  }, [selected, r.data]);
  if (!reports.length && !selected) return null;
  if (!r.data && selected)
    return r.error ? (
      <div className="callout" role="alert">
        {r.error}
      </div>
    ) : (
      <Loading what="Loading saved report" />
    );
  const shown = selected ? reports.filter((x) => x.revision === selected) : reports;
  const last = reports[reports.length - 1];
  return (
    <details className="card report-card" ref={container} open={selected ? true : undefined}>
      <summary className="card-h">
        {selected ? `Saved report r${selected}` : "Reports"}{" "}
        <span className="sub">
          {selected
            ? "immutable snapshot · evaluation above shows current results"
            : `revision ${last?.revision} · ${last?.reason} · plan ${last?.planDigest.slice(7, 19)}`}
        </span>
      </summary>
      <div className="card-b">
        <table className="table">
          <thead>
            <tr>
              <th>Rev</th>
              <th>Created</th>
              <th>Reason</th>
              <th>Plan</th>
              <th>Per configuration</th>
            </tr>
          </thead>
          <tbody>
            {[...shown].reverse().map((x) => (
              <tr key={x.revision}>
                <td>{x.revision}</td>
                <td>{dateTime(x.createdAt)}</td>
                <td>{x.reason}</td>
                <td className="mono">{x.planDigest.slice(7, 19)}</td>
                <td>
                  {x.methods
                    .map(
                      (m) =>
                        `${m.method}: ${m.valid}/${m.planned} valid` +
                        (m.missing ? `, ${m.missing} missing` : "") +
                        (m.orbit ? `, Orbit ${m.orbit.mean.toFixed(2)}` : "") +
                        (m.official?.value != null
                          ? `, official ${m.official.value.toFixed(2)}`
                          : ""),
                    )
                    .join(" · ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {selected && !shown.length && <p role="alert">Report r{selected} was not found.</p>}
        <p className="faint">
          Full entries (sample, attempt, runs):{" "}
          <code>
            orbit bench report {id} -r {selected ?? last?.revision}
          </code>
        </p>
      </div>
    </details>
  );
}
