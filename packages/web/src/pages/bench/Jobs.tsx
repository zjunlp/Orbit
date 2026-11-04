import { benchCategory } from "@zjunlp/orbit/categories";
import { fmtCi, fmtMetric, primaryMetric, resolveMetrics } from "@zjunlp/orbit/metrics";
import { useState } from "react";
import { IconCompare, IconFlask } from "../../components/icons.tsx";
import { TopBar } from "../../components/TopBar.tsx";
import { Empty, Link, Loading } from "../../components/ui.tsx";
import { api, type BenchJobList, type Benchmark } from "../../lib/api.ts";
import { BENCH_CATEGORIES, CATEGORY_LABELS, categoryLabel } from "../../lib/category.ts";
import { ago, jobPath } from "../../lib/format.ts";
import { navigate, onLinkClick, setQuery, useLocation } from "../../lib/router.ts";
import { useAsync } from "../../lib/use.ts";

import { JobState, jobLabel, summaryTitle } from "./common.tsx";
import "./launch.css";

export function BenchJobs() {
  const jobs = useAsync(() => api.benchJobs(), [], { poll: true, pollMs: 4000 });
  const benchmarks = useAsync(() => api.benchmarks(), []);
  const loc = useLocation();
  const selected = (loc.query.get("sel") ?? "").split(",").filter(Boolean);
  const tab = loc.query.get("tab") === "environments" ? "environments" : "jobs";
  const query = loc.query.get("q") ?? "";
  const status = loc.query.get("state") ?? "all";
  const category = loc.query.get("category") ?? "all";
  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    setQuery({ sel: next.join(",") || null });
  };
  const filtered = (jobs.data ?? []).filter((j) => {
    const verifying = j.state !== "running" && j.summary.some((s) => s.pending > 0);
    const state = verifying ? "verifying" : j.state;
    return (
      (status === "all" || state === status) &&
      (category === "all" || benchCategory(j.capabilities) === category) &&
      `${jobLabel(j)} ${j.id} ${j.spec.benchmark} ${j.spec.methods.map((m) => m.name).join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase())
    );
  });

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
        <Link className="btn primary sm" href="/bench/new">
          New evaluation
        </Link>
      </TopBar>
      <div className="page">
        <div className="page-pad col" style={{ gap: 16 }}>
          <div className="row bench-wrap">
            <button
              type="button"
              className={`btn sm${tab === "jobs" ? " on" : " ghost"}`}
              aria-pressed={tab === "jobs"}
              onClick={() => setQuery({ tab: null })}
            >
              Evaluations {jobs.data?.length ?? ""}
            </button>
            <button
              type="button"
              className={`btn sm${tab === "environments" ? " on" : " ghost"}`}
              aria-pressed={tab === "environments"}
              onClick={() => setQuery({ tab: "environments" })}
            >
              Registered environments {benchmarks.data?.length ?? ""}
            </button>
          </div>
          {tab === "jobs" ? (
            <>
              <div className="bench-home-toolbar">
                <input
                  className="input"
                  type="search"
                  aria-label="Search evaluations"
                  placeholder="Search evaluations, environments or methods"
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
                <select
                  className="input"
                  aria-label="Filter by category"
                  value={category}
                  onChange={(e) =>
                    setQuery({ category: e.target.value === "all" ? null : e.target.value })
                  }
                >
                  <option value="all">All categories</option>
                  {BENCH_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </option>
                  ))}
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
                  <p>Select a registered environment and methods to start your first evaluation.</p>
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
            <section className="card">
              <div className="card-h">Registered environments</div>
              {benchmarks.error ? (
                <div className="card-b callout" role="alert">
                  {benchmarks.error}
                </div>
              ) : !benchmarks.data ? (
                <Loading what="Loading environments" />
              ) : !benchmarks.data.length ? (
                <div className="card-b col">
                  <p className="muted">
                    Prepare a benchmark and register its adapter on the daemon host:
                  </p>
                  <code>orbit bench add mine /path/to/benchmark --adapter /path/to/adapter.py</code>
                </div>
              ) : (
                <div className="card-b col" style={{ gap: 16 }}>
                  {benchmarks.data.map((b) => (
                    <Environment key={b.name} benchmark={b} />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </>
  );
}

function Environment({ benchmark: b }: { benchmark: Benchmark }) {
  const [open, setOpen] = useState(false);
  const info = useAsync(
    () => (open ? api.benchInfo(b.name) : Promise.resolve(null)),
    [open, b.name],
  );
  return (
    <div className="bench-environment-details">
      <div className="row bench-wrap">
        <b>{b.name}</b>
        <span className="chip">Registered</span>
        <span className="faint">updated {ago(b.updatedAt)}</span>
        <span className="spacer" />
        <Link className="btn sm" href={`/bench/new?benchmark=${encodeURIComponent(b.name)}`}>
          New evaluation
        </Link>
      </div>
      <details onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>Configuration & task coverage</summary>
        <div className="col" style={{ gap: 10, marginTop: 10 }}>
          <dl className="kv">
            <dt>Adapter</dt>
            <dd className="mono">{b.adapter}</dd>
            <dt>Checkout</dt>
            <dd className="mono">{b.path}</dd>
            <dt>Resources</dt>
            <dd className="mono">{b.resources ?? "Adapter defaults"}</dd>
          </dl>
          {info.loading ? (
            <span className="muted">Listing tasks…</span>
          ) : info.error ? (
            <div className="callout">{info.error}</div>
          ) : (
            info.data && (
              <>
                <p>
                  {info.data.tasks.filter((t) => t.supported).length} supported /{" "}
                  {info.data.tasks.length} listed tasks
                </p>
                {info.data.capabilities && (
                  <dl className="kv">
                    {Object.entries(info.data.capabilities.conditions).map(([key, value]) => (
                      <div key={key} style={{ display: "contents" }}>
                        <dt>{key}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </>
            )
          )}
          <p className="muted">
            Registration and task listing do not verify environment startup or model connectivity.
          </p>
        </div>
      </details>
    </div>
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
          <th>Methods (primary metric ± 95% CI · valid/total)</th>
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
                {categoryLabel(j.capabilities) && (
                  <div className="faint">{categoryLabel(j.capabilities)}</div>
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
