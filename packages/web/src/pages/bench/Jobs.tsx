import { fmtCi, fmtMetric, primaryMetric, resolveMetrics } from "@zjunlp/orbit/metrics";
import { IconCompare, IconFlask } from "../../components/icons.tsx";
import { PageHeader } from "../../components/PageHeader.tsx";
import { TopBar } from "../../components/TopBar.tsx";
import { Empty, Link, Loading } from "../../components/ui.tsx";
import { api, type BenchJobList } from "../../lib/api.ts";
import { ago, jobPath } from "../../lib/format.ts";
import { navigate, onLinkClick, setQuery, useLocation } from "../../lib/router.ts";
import { useAsync } from "../../lib/use.ts";
import { BenchCatalogView } from "./Catalog.tsx";

import { JobState, jobLabel, summaryTitle } from "./common.tsx";
import "./launch.css";

export function BenchJobs() {
  const jobs = useAsync(() => api.benchJobs(), [], { poll: true, pollMs: 4000 });
  const benchmarks = useAsync(() => api.benchmarks(), []);
  const loc = useLocation();
  const selected = (loc.query.get("sel") ?? "").split(",").filter(Boolean);
  const tab = "jobs" as "jobs" | "catalog";
  const query = loc.query.get("q") ?? "";
  const status = loc.query.get("state") ?? "all";
  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    setQuery({ sel: next.join(",") || null });
  };
  const filtered = (jobs.data ?? []).filter((j) => {
    const verifying = j.state !== "running" && j.summary.some((s) => s.pending > 0);
    const state = verifying ? "verifying" : j.state;
    return (
      (status === "all" || state === status) &&
      `${jobLabel(j)} ${j.id} ${j.spec.benchmark} ${j.spec.methods.map((m) => m.name).join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase())
    );
  });

  return (
    <>
      <TopBar crumbs={[{ label: "Evaluations" }]}>
        {tab === "jobs" && (
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
        )}
        <Link className="btn primary sm" href="/bench/new">
          New evaluation
        </Link>
      </TopBar>
      <div className="page">
        <div className="page-pad col" style={{ gap: 16 }}>
          <PageHeader
            title="Evaluations"
            description={
              <>
                Every evaluation of a benchmark: configurations × tasks × seeds, each trial solved
                and then verified. Browse what can be evaluated under{" "}
                <Link href="/benchmarks">
                  Benchmarks ({benchmarks.data?.length ?? "…"} registered)
                </Link>
                .
              </>
            }
          />
          {tab === "jobs" ? (
            <>
              <div className="bench-home-toolbar">
                <input
                  className="input"
                  type="search"
                  aria-label="Search evaluations"
                  placeholder="Search evaluations, environments or configurations"
                  value={query}
                  onChange={(e) => setQuery({ q: e.target.value || null })}
                />
                <select
                  className="input"
                  aria-label="Filter by evaluation state"
                  value={status}
                  onChange={(e) =>
                    setQuery({ state: e.target.value === "all" ? null : e.target.value })
                  }
                >
                  <option value="all">All states</option>
                  <option value="running">Running</option>
                  <option value="verifying">Verification in progress</option>
                  <option value="done">Ended</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
              {jobs.error && (
                <div className="callout" role="alert">
                  {jobs.error}
                </div>
              )}
              {!jobs.data ? (
                <Loading what="Loading evaluations" />
              ) : jobs.data.length === 0 ? (
                <Empty title="No evaluations yet" icon={<IconFlask size={36} />}>
                  <p>
                    Select a registered environment and configurations to start your first
                    evaluation.
                  </p>
                  <p>
                    <Link className="btn primary" href="/bench/new">
                      New evaluation
                    </Link>
                  </p>
                </Empty>
              ) : !filtered.length ? (
                <Empty title="No matching evaluations">
                  Change the search or filters to see more results.
                </Empty>
              ) : (
                <section className="card">
                  <div className="card-h">
                    Evaluations <span className="sub">{filtered.length} shown</span>
                  </div>
                  <div className="bench-home-table">
                    <JobTable jobs={filtered} selected={selected} toggle={toggle} />
                  </div>
                </section>
              )}
            </>
          ) : (
            <BenchCatalogView />
          )}
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
          <th>Execution</th>
          <th title="Primary metric ± 95% CI over valid trials · valid/total trials">
            Results by configuration
          </th>
          <th className="r">Created</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => {
          const m = primaryMetric(resolveMetrics(j.metrics));
          const pending = j.summary.reduce((n, s) => n + s.pending, 0);
          const total = j.summary.reduce((n, s) => n + s.trials, 0);
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
              <td>
                {j.spec.benchmark}
                {j.capabilities?.identity && j.capabilities.identity.id !== j.spec.benchmark && (
                  <div className="faint">{j.capabilities.identity.name}</div>
                )}
              </td>
              <td>
                <JobState state={j.state} />
                {j.state !== "running" && pending > 0 && (
                  <div className="muted">Verifying saved output</div>
                )}
                <div className="faint">
                  {total - pending}/{total} finished
                </div>
                <progress
                  className="bench-job-progress"
                  value={total - pending}
                  max={Math.max(total, 1)}
                  aria-label={`${total - pending} of ${total} trials finished`}
                />
              </td>
              <td className="wrap">
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
