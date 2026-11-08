// Overview (design §9.16): the home page — what Orbit can evaluate (benchmarks by category and
// domain), who can run it (Agents and their evidence), what is happening now and how methods evolved.

import { benchCategory } from "@zjunlp/orbit/categories";
import { fmtMetric, primaryMetric, resolveMetrics } from "@zjunlp/orbit/metrics";
import {
  IconBot,
  IconBranch,
  IconCheck,
  IconFlask,
  IconLibrary,
  IconRuns,
} from "../components/icons.tsx";
import { TopBar } from "../components/TopBar.tsx";
import { Link, Loading, StateBadge } from "../components/ui.tsx";
import { api, type MethodLine } from "../lib/api.ts";
import {
  BENCH_CATEGORIES,
  BENCH_DOMAINS,
  CATEGORY_LABELS,
  DOMAIN_LABELS,
} from "../lib/category.ts";
import { ago, isActive, jobPath, runPath, runTitle } from "../lib/format.ts";
import { useRuns } from "../lib/runs-store.ts";
import { useAsync } from "../lib/use.ts";
import { calState, distinct } from "./bench/Catalog.tsx";
import { jobLabel } from "./bench/common.tsx";
import "./hub.css";

const SCORE = primaryMetric(resolveMetrics([]));

/** The newest paired comparisons across method lines, newest first. */
export function recentChanges(lines: MethodLine[], n = 5) {
  return lines
    .flatMap((l) =>
      l.revisions.flatMap((r) =>
        r.results.filter((x) => x.versus).map((x) => ({ line: l.name, r, x })),
      ),
    )
    .sort((a, b) => (a.x.at < b.x.at ? 1 : -1))
    .slice(0, n);
}

export function Overview() {
  const catalog = useAsync(() => api.benchCatalog().then((r) => r.entries), [], {
    poll: true,
    pollMs: 10000,
  });
  const agents = useAsync(() => api.agentCatalog(), [], { poll: true, pollMs: 20000 });
  const methods = useAsync(() => api.methods(), [], { poll: true, pollMs: 20000 });
  const jobs = useAsync(() => api.benchJobs(), [], { poll: true, pollMs: 5000 });
  const runs = useRuns();
  const entries = catalog.data ?? [];
  const agentList = agents.data?.agents ?? [];
  const lines = (methods.data ?? []).filter((l) => l.revisions.length);
  const loaded = catalog.data && agents.data && jobs.data && methods.data;
  const failures = [
    { label: "Benchmarks", request: catalog },
    { label: "Agents", request: agents },
    { label: "Methods", request: methods },
    { label: "Evaluations", request: jobs },
  ].filter(({ request }) => request.error);
  const realJobs = (jobs.data ?? []).filter((j) => !j.spec.calibration);
  const running = (jobs.data ?? []).filter(
    (j) => j.state === "running" || j.summary.some((s) => s.pending > 0),
  );
  const review = realJobs
    .filter((j) => j.state !== "running")
    .filter((j) =>
      j.summary.some((s) => s.invalid > 0 || (s.metrics[SCORE.name]?.mean ?? 100) < 100),
    )
    .slice(0, 6);
  const activeRuns = runs.filter((r) => isActive(r.state)).slice(0, 6);
  const steps = [
    {
      done: entries.length > 0,
      label: "Register a benchmark",
      hint: "orbit bench add NAME PATH --adapter …",
      href: "/benchmarks",
    },
    {
      done: entries.some((e) => calState(e) === "passed"),
      label: "Calibrate it",
      hint: "check the integration judges correctly",
      href: "/benchmarks",
    },
    {
      done: agentList.some((a) => a.profiles.length),
      label: "Add Agent credentials",
      hint: "orbit auth add NAME --harness codex …",
      href: "/agents",
    },
    {
      done: realJobs.some((j) =>
        j.spec.methods.some((m) => !["oracle", "empty"].includes(m.agent)),
      ),
      label: "Run a real method",
      hint: "an Agent or policy on the benchmark",
      href: "/bench/new",
    },
  ];
  const changes = recentChanges(lines);
  return (
    <>
      <TopBar crumbs={[{ label: "Overview" }]}>
        <Link className="btn primary sm" href="/bench/new">
          New evaluation
        </Link>
      </TopBar>
      <div className="page">
        <div className="page-pad col overview" style={{ gap: 18 }}>
          <div className="overview-hero">
            <h1>
              Any harness <span className="faint">×</span> any bench{" "}
              <span className="faint">→</span> iterate
            </h1>
            <p className="muted">
              Run any Agent or policy on any benchmark in isolated containers, keep the evidence,
              and compare each revision of a method with the one before.
            </p>
          </div>
          {failures.map(({ label, request }) => (
            <div className="callout" role="alert" key={label}>
              <span>
                {label}: {request.error}
                {request.data && " Showing the last loaded data."}
              </span>
              <button type="button" className="btn sm" onClick={request.reload}>
                Retry
              </button>
            </div>
          ))}
          {!loaded ? (
            failures.length ? null : (
              <Loading what="Loading overview" />
            )
          ) : (
            <>
              <div className="pillars">
                <Pillar
                  href="/agents"
                  icon={<IconBot size={18} />}
                  title="Agents"
                  big={agentList.length}
                  unit="harnesses"
                  lines={[
                    `${agentList.filter((a) => a.evidence).length} with evidence on this node`,
                    `${agentList.filter((a) => a.capabilities.mcp.wired).length} MCP-wired · ${agentList.filter((a) => a.capabilities.gui.wired).length} GUI`,
                    `${agentList.filter((a) => a.profiles.length).length} with credentials`,
                  ]}
                />
                <span className="pillar-op">×</span>
                <Pillar
                  href="/benchmarks"
                  icon={<IconLibrary size={18} />}
                  title="Benchmarks"
                  big={distinct(entries)}
                  unit="benchmarks"
                  lines={[
                    `${new Set(entries.map((e) => benchCategory(e.capabilities ?? undefined)).filter(Boolean)).size}/7 categories · ${new Set(entries.flatMap((e) => e.domains)).size} domains`,
                    `${distinct(entries.filter((e) => calState(e) === "passed"))} sample-calibrated`,
                    `${entries.length} registrations`,
                  ]}
                />
                <span className="pillar-op">→</span>
                <Pillar
                  href="/methods"
                  icon={<IconBranch size={18} />}
                  title="Methods"
                  big={lines.reduce((n, l) => n + l.revisions.length, 0)}
                  unit="revisions"
                  lines={[
                    `${lines.length} method lines`,
                    `${lines.reduce((n, l) => n + l.revisions.filter((r) => r.lineage?.parent).length, 0)} with a declared parent`,
                    changes.length ? `latest change ${ago(changes[0]?.x.at)}` : "no comparison yet",
                  ]}
                />
              </div>
              {steps.some((s) => !s.done) && (
                <section className="card">
                  <div className="card-h">
                    Getting started{" "}
                    <span className="sub">
                      {steps.filter((s) => s.done).length}/{steps.length}
                    </span>
                  </div>
                  <ol className="steps">
                    {steps.map((s) => (
                      <li key={s.label} className={s.done ? "done" : ""}>
                        <span className="step-mark">{s.done ? <IconCheck size={13} /> : null}</span>
                        <Link href={s.href}>{s.label}</Link>
                        <span className="faint mono">{s.hint}</span>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              <div className="overview-grid">
                <section className="card">
                  <div className="card-h">
                    What you can evaluate
                    <span className="spacer" />
                    <Link href="/benchmarks?view=matrix" className="sub">
                      Coverage matrix →
                    </Link>
                  </div>
                  <div className="card-b col" style={{ gap: 12 }}>
                    <Bars
                      title="By category"
                      items={BENCH_CATEGORIES.map((c) => ({
                        key: c,
                        label: CATEGORY_LABELS[c],
                        n: distinct(
                          entries.filter((e) => benchCategory(e.capabilities ?? undefined) === c),
                        ),
                        href: `/benchmarks?category=${c}`,
                      }))}
                    />
                    <Bars
                      title="By domain"
                      items={[...BENCH_DOMAINS, "unlabeled"].map((d) => ({
                        key: d,
                        label:
                          d === "unlabeled"
                            ? "Unlabeled"
                            : DOMAIN_LABELS[d as keyof typeof DOMAIN_LABELS],
                        n: distinct(
                          entries.filter((e) =>
                            d === "unlabeled" ? !e.domains.length : e.domains.includes(d),
                          ),
                        ),
                        href: `/benchmarks?domain=${d}`,
                      }))}
                    />
                  </div>
                </section>
                <section className="card">
                  <div className="card-h">
                    What is happening
                    <span className="spacer" />
                    <Link href="/bench" className="sub">
                      Evaluations →
                    </Link>
                  </div>
                  <div className="card-b col" style={{ gap: 10 }}>
                    {!running.length && !activeRuns.length && (
                      <p className="faint">Nothing running.</p>
                    )}
                    {running.slice(0, 5).map((j) => {
                      const total = j.summary.reduce((n, s) => n + s.trials, 0);
                      const pending = j.summary.reduce((n, s) => n + s.pending, 0);
                      return (
                        <Link key={j.id} href={jobPath(j.id)} className="now-row">
                          <IconFlask size={13} />
                          <span className="ellipsis">{jobLabel(j)}</span>
                          <span className="faint">{j.spec.benchmark}</span>
                          <progress value={total - pending} max={Math.max(total, 1)} />
                          <span className="faint num">
                            {total - pending}/{total}
                          </span>
                        </Link>
                      );
                    })}
                    {activeRuns.map((r) => (
                      <Link key={r.id} href={runPath(r.id)} className="now-row">
                        <IconRuns size={13} />
                        <span className="ellipsis">{runTitle(r)}</span>
                        <StateBadge state={r.state} />
                        {r.reason && r.state === "queued" && (
                          <span className="faint ellipsis">{r.reason}</span>
                        )}
                      </Link>
                    ))}
                    <div className="catalog-h" style={{ marginTop: 6 }}>
                      Needs review
                    </div>
                    {!review.length ? (
                      <p className="faint">No finished evaluation with failures.</p>
                    ) : (
                      review.map((j) => (
                        <Link
                          key={j.id}
                          href={`${jobPath(j.id)}?result=${j.summary.some((s) => s.invalid > 0) ? "issues" : "all"}`}
                          className="now-row"
                        >
                          <span className="ellipsis">{jobLabel(j)}</span>
                          <span className="faint">{j.spec.benchmark}</span>
                          <span className="spacer" />
                          {j.summary.map((s) => (
                            <span key={s.method} className="chip">
                              {s.method} <b>{fmtMetric(s.metrics[SCORE.name]?.mean, SCORE)}</b>
                              {s.invalid > 0 && (
                                <span className="bad-text"> · {s.invalid} invalid</span>
                              )}
                            </span>
                          ))}
                        </Link>
                      ))
                    )}
                  </div>
                </section>
                <section className="card overview-wide">
                  <div className="card-h">
                    How methods evolved
                    <span className="spacer" />
                    <Link href="/methods" className="sub">
                      Methods →
                    </Link>
                  </div>
                  {!changes.length ? (
                    <div className="card-b faint">
                      No paired comparison yet. Run a second revision of a method on the same
                      benchmark (change its model, settings or bundle) to see the difference here.
                    </div>
                  ) : (
                    <div className="matrix-wrap">
                      <table className="table">
                        <tbody>
                          {changes.map(({ line, r, x }) => {
                            const d = x.versus?.diff;
                            const metric = x.metric ?? SCORE;
                            const direction =
                              d?.ci && d.ci[0] > 0 ? 1 : d?.ci && d.ci[1] < 0 ? -1 : 0;
                            const sign =
                              direction === 0
                                ? "flat"
                                : direction > 0 === metric.higherIsBetter
                                  ? "up"
                                  : "down";
                            const query = new URLSearchParams({ m: line, b: x.benchmark });
                            if (x.condition) query.set("c", x.condition);
                            if (x.taskSet) query.set("tasks", x.taskSet);
                            if (metric.name) query.set("metric", metric.name);
                            return (
                              <tr key={`${line}/${x.job}`}>
                                <td>
                                  <Link href={`/methods?${query}`}>
                                    <b>{line}</b>
                                  </Link>{" "}
                                  <span className="mono faint">
                                    {x.versus?.revision.slice(0, 6)} → {r.revision.slice(0, 6)}
                                  </span>
                                  {r.lineage?.note && (
                                    <div className="catalog-sub">{r.lineage.note}</div>
                                  )}
                                </td>
                                <td className="faint">{x.benchmark}</td>
                                <td className={`r num delta-${sign}`}>
                                  {d ? fmtMetric(d.mean, metric, true) : "—"}
                                  <div className="faint catalog-sub">
                                    {metric.label} · {x.versus?.pairedTasks} paired
                                    {x.versus?.subset ? " · subset" : ""}
                                  </div>
                                </td>
                                <td className="r faint">{ago(x.at)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Pillar(props: {
  href: string;
  icon: React.ReactNode;
  title: string;
  big: number;
  unit: string;
  lines: string[];
}) {
  return (
    <Link href={props.href} className="pillar">
      <span className="pillar-h">
        {props.icon} {props.title}
      </span>
      <span className="pillar-big">
        <b className="num">{props.big}</b> <span className="faint">{props.unit}</span>
      </span>
      {props.lines.map((l) => (
        <span key={l} className="pillar-line">
          {l}
        </span>
      ))}
    </Link>
  );
}

function Bars({
  title,
  items,
}: {
  title: string;
  items: { key: string; label: string; n: number; href: string }[];
}) {
  const max = Math.max(1, ...items.map((i) => i.n));
  return (
    <div>
      <div className="catalog-h">{title}</div>
      <div className="bars">
        {items
          .filter((i) => i.n > 0)
          .map((i) => (
            <Link key={i.key} href={i.href} className="bar-row">
              <span className="ellipsis">{i.label}</span>
              <span className="bar">
                <span style={{ width: `${(100 * i.n) / max}%` }} />
              </span>
              <span className="num">{i.n}</span>
            </Link>
          ))}
        {items.every((i) => !i.n) && <span className="faint">none</span>}
      </div>
    </div>
  );
}
