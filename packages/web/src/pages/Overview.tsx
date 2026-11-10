import type { SupportedBenchmark } from "@zjunlp/orbit/contracts";
import { fmtMetric, primaryMetric, resolveMetrics } from "@zjunlp/orbit/metrics";
import { TAXONOMY_FIELDS, TAXONOMY_GROUPS, type TaxonomyField } from "@zjunlp/orbit/taxonomy";
import {
  IconBot,
  IconBox,
  IconBrain,
  IconCheck,
  IconChevron,
  IconDashboard,
  IconFlask,
  IconLayers,
  IconLibrary,
  IconRuns,
  IconTerminal,
} from "../components/icons.tsx";
import { TopBar } from "../components/TopBar.tsx";
import { Link, Loading, StateBadge } from "../components/ui.tsx";
import { api, type MethodLine } from "../lib/api.ts";
import { ago, isActive, jobPath, runPath, runTitle } from "../lib/format.ts";
import { useRuns } from "../lib/runs-store.ts";
import { matchesTaxonomy, taxonomyLabel } from "../lib/taxonomy.ts";
import { useAsync } from "../lib/use.ts";
import { calState } from "./bench/Catalog.tsx";
import { jobLabel } from "./bench/common.tsx";
import "./hub.css";
import "./overview.css";

const SCORE = primaryMetric(resolveMetrics([]));
const DIMENSION_ICONS = [IconLayers, IconTerminal, IconBrain, IconDashboard, IconBox, IconCheck];
type LibraryItem = Pick<SupportedBenchmark, "id" | "taxonomyGroups">;

/** Counts are distinct product families with a matching profile, independent of local setups. */
export function overviewDimensions(products: LibraryItem[]) {
  return TAXONOMY_GROUPS.map((group) => ({
    ...group,
    fields: group.fields.map((field) => {
      const values = [...TAXONOMY_FIELDS[field].values.map((v) => v.value), "__none__"]
        .map((value) => ({
          value,
          label: taxonomyLabel(field, value),
          count: new Set(
            products.filter((p) => matchesTaxonomy(p, { [field]: [value] })).map((p) => p.id),
          ).size,
        }))
        .filter((v) => v.count > 0)
        .sort((a, b) => b.count - a.count);
      return { field, label: TAXONOMY_FIELDS[field].label, values };
    }),
  }));
}

export function taxonomyOverviewHref(dimension: string, field?: TaxonomyField, value?: string) {
  const query = new URLSearchParams({ dimension });
  if (field && value) query.set(field, value);
  return `/benchmarks?${query}`;
}

/** The newest paired comparisons across named configurations, newest first. */
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
  const catalog = useAsync(() => api.benchCatalog(), [], { poll: true, pollMs: 10000 });
  const agents = useAsync(() => api.agentCatalog(), [], { poll: true, pollMs: 20000 });
  const methods = useAsync(() => api.methods(), [], { poll: true, pollMs: 20000 });
  const jobs = useAsync(() => api.benchJobs(), [], { poll: true, pollMs: 5000 });
  const runs = useRuns();
  const entries = catalog.data?.entries ?? [];
  const products = catalog.data?.supported ?? [];
  const families = new Set(products.map((p) => p.id)).size;
  const agentList = agents.data?.agents ?? [];
  const lines = (methods.data ?? []).filter((l) => l.revisions.length);
  const loaded = catalog.data && agents.data && jobs.data && methods.data;
  const failures = [
    { label: "Benchmarks", request: catalog },
    { label: "Agents", request: agents },
    { label: "Evaluation configurations", request: methods },
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
  const calibrated = entries.filter((e) => calState(e) === "passed").length;
  const steps = [
    {
      done: entries.length > 0,
      label: "Set up a benchmark",
      hint: "Choose an integration from the library",
      href: "/benchmarks",
    },
    {
      done: agentList.some((a) => a.profiles.length),
      label: "Configure your Agent",
      hint: "Add a credential profile",
      href: "/agents",
    },
    {
      done: calibrated > 0,
      label: "Calibrate the setup",
      hint: "Check the integration on a sample",
      href: "/benchmarks?mode=local",
    },
    {
      done: realJobs.some((j) =>
        j.spec.methods.some((m) => !["oracle", "empty"].includes(m.agent)),
      ),
      label: "Run an evaluation",
      hint: "Keep a result to compare and improve",
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
        <div className="overview-page">
          <header className="overview-intro">
            <div>
              <p className="overview-eyebrow">ORBIT WORKSPACE</p>
              <h1>Explore. Evaluate. Improve.</h1>
              <p>Find a benchmark, configure an Agent or policy, and compare evaluation results.</p>
            </div>
            <Link className="btn overview-browse" href="/benchmarks">
              Browse benchmarks <IconChevron size={15} />
            </Link>
          </header>
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
              <section className="overview-summary" aria-label="Workspace overview">
                <SummaryCard
                  href="/benchmarks"
                  icon={<IconLibrary size={19} />}
                  label="Benchmark library"
                  value={families}
                  unit="benchmark families"
                  detail="Integrated with Orbit · browse before setting up"
                  primary
                />
                <SummaryCard
                  href="/agents"
                  icon={<IconBot size={19} />}
                  label="Agents"
                  value={agentList.length}
                  unit="registered harnesses"
                  detail={`${agentList.filter((a) => a.evidence).length} with evidence here · ${agentList.filter((a) => a.profiles.length).length} with credentials`}
                />
                <SummaryCard
                  href="/configurations"
                  icon={<IconLayers size={19} />}
                  label="Evaluation configurations"
                  value={lines.reduce((n, l) => n + l.revisions.length, 0)}
                  unit="configuration versions"
                  detail={`${lines.length} named configurations · ${changes.length ? `latest comparison ${ago(changes[0]?.x.at)}` : "no paired comparison yet"}`}
                />
              </section>
              <section className="overview-local" aria-label="Local setup evidence">
                <span>On this node</span>
                <Link href="/benchmarks?mode=local">
                  <b>{entries.length}</b> local setups
                </Link>
                <Link href="/benchmarks?mode=local&ev=calibrated">
                  <b>{calibrated}</b> sample-calibrated setups
                </Link>
                <Link href="/benchmarks?mode=local&ev=real">
                  <b>{entries.filter((e) => e.methods.length > 0).length}</b> setups with evaluation
                  results
                </Link>
              </section>
              <OverviewTaxonomy products={products} />
              <section className="card overview-activity">
                <div className="card-h">
                  <h2>Activity on this node</h2>
                  <span className="spacer" />
                  <Link href="/bench" className="sub">
                    Evaluations <IconChevron size={12} />
                  </Link>
                </div>
                <div className="overview-activity-grid">
                  <div>
                    <h3>In progress</h3>
                    {!running.length && !activeRuns.length && (
                      <p className="overview-quiet">
                        Nothing running. Your next evaluation starts here.
                      </p>
                    )}
                    {running.slice(0, 5).map((j) => {
                      const total = j.summary.reduce((n, s) => n + s.trials, 0);
                      const pending = j.summary.reduce((n, s) => n + s.pending, 0);
                      return (
                        <Link key={j.id} href={jobPath(j.id)} className="overview-job-row">
                          <IconFlask size={15} />
                          <span className="overview-row-main">
                            <b>{jobLabel(j)}</b>
                            <small>{j.spec.benchmark}</small>
                          </span>
                          <span className="overview-progress">
                            <progress
                              value={total - pending}
                              max={Math.max(total, 1)}
                              aria-label={`${jobLabel(j)} completed trials`}
                            />
                            <small>
                              {total - pending}/{total} trials
                            </small>
                          </span>
                        </Link>
                      );
                    })}
                    {activeRuns.map((r) => (
                      <Link key={r.id} href={runPath(r.id)} className="overview-job-row">
                        <IconRuns size={15} />
                        <span className="overview-row-main">
                          <b>{runTitle(r)}</b>
                          {r.reason && r.state === "queued" && <small>{r.reason}</small>}
                        </span>
                        <StateBadge state={r.state} />
                      </Link>
                    ))}
                    <Link href="/runs" className="overview-text-link">
                      View runs <IconChevron size={12} />
                    </Link>
                  </div>
                  <div>
                    <h3>Needs review</h3>
                    {!review.length ? (
                      <p className="overview-quiet">No finished evaluation with failures.</p>
                    ) : (
                      review.map((j) => (
                        <Link
                          key={j.id}
                          href={`${jobPath(j.id)}?result=${j.summary.some((s) => s.invalid > 0) ? "issues" : "all"}`}
                          className="overview-review-row"
                        >
                          <span className="overview-row-main">
                            <b>{jobLabel(j)}</b>
                            <small>{j.spec.benchmark}</small>
                          </span>
                          <span className="overview-review-scores">
                            {j.summary.map((s) => (
                              <span key={s.method} className="chip">
                                {s.method} <b>{fmtMetric(s.metrics[SCORE.name]?.mean, SCORE)}</b>
                                {s.invalid > 0 && (
                                  <span className="bad-text"> · {s.invalid} invalid</span>
                                )}
                              </span>
                            ))}
                          </span>
                        </Link>
                      ))
                    )}
                  </div>
                </div>
              </section>
              <section className="card overview-evolution">
                <div className="card-h">
                  <h2>Configuration comparisons</h2>
                  <span className="spacer" />
                  <Link href="/configurations" className="sub">
                    Configurations <IconChevron size={12} />
                  </Link>
                </div>
                {!changes.length ? (
                  <div className="overview-quiet overview-evolution-empty">
                    <IconLayers size={22} />
                    <div>
                      <b>Compare results across configuration versions.</b>
                      <p>
                        Evaluate a different model, reasoning effort or instruction bundle on the
                        same benchmark and task set to compare results.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="matrix-wrap">
                    <table className="table overview-change-table">
                      <thead>
                        <tr>
                          <th>Configuration version</th>
                          <th>Benchmark</th>
                          <th className="r">Paired change</th>
                          <th className="r">When</th>
                        </tr>
                      </thead>
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
                                <Link href={`/configurations?${query}`}>
                                  <b>{line}</b>
                                </Link>
                                <div className="mono faint">
                                  {x.versus?.revision.slice(0, 6)} → {r.revision.slice(0, 6)}
                                </div>
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
              {steps.some((s) => !s.done) && (
                <section className="overview-start">
                  <div className="overview-section-heading">
                    <div>
                      <h2>Getting started</h2>
                      <p>Prepare a local setup when you are ready to evaluate.</p>
                    </div>
                    <span className="faint">
                      {steps.filter((s) => s.done).length}/{steps.length} complete
                    </span>
                  </div>
                  <ol>
                    {steps.map((s) => (
                      <li key={s.label} className={s.done ? "done" : ""}>
                        <span className="overview-step-mark">
                          {s.done ? <IconCheck size={12} /> : <IconChevron size={12} />}
                        </span>
                        <div>
                          <Link href={s.href}>{s.label}</Link>
                          <small>{s.hint}</small>
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function SummaryCard(props: {
  href: string;
  icon: React.ReactNode;
  label: string;
  value: number;
  unit: string;
  detail: string;
  primary?: boolean;
}) {
  return (
    <Link href={props.href} className={`overview-summary-card${props.primary ? " primary" : ""}`}>
      <span className="overview-summary-label">
        {props.icon}
        {props.label}
        <IconChevron size={13} />
      </span>
      <span className="overview-summary-value">
        <b>{props.value}</b>
        <span>{props.unit}</span>
      </span>
      <span className="overview-summary-detail">{props.detail}</span>
    </Link>
  );
}

export function OverviewTaxonomy({ products }: { products: LibraryItem[] }) {
  const dimensions = overviewDimensions(products);
  return (
    <section className="overview-discovery" aria-labelledby="overview-discovery-title">
      <div className="overview-section-heading">
        <div>
          <h2 id="overview-discovery-title">Find benchmarks by what they evaluate</h2>
          <p>Six ways to explore the library. Each value links to matching benchmark families.</p>
        </div>
        <Link href="/benchmarks?view=matrix" className="overview-text-link">
          Explore the matrix <IconChevron size={13} />
        </Link>
      </div>
      {!products.length ? (
        <div className="overview-quiet">
          The benchmark library is not available yet.{" "}
          <Link href="/benchmarks">Open the library</Link> to check its status.
        </div>
      ) : (
        <div className="overview-dimensions">
          {dimensions.map((group, index) => {
            const Icon = DIMENSION_ICONS[index] ?? IconLayers;
            return (
              <article className="overview-dimension" key={group.id}>
                <Link href={taxonomyOverviewHref(group.id)} className="overview-dimension-heading">
                  <span className="overview-dimension-icon">
                    <Icon size={22} />
                  </span>
                  <h3>{group.label}</h3>
                  <IconChevron size={15} />
                </Link>
                <p>{group.question}</p>
                <div className="overview-dimension-fields">
                  {group.fields.map(({ field, label, values }) => (
                    <div className="overview-dimension-field" key={field}>
                      {group.fields.length > 1 && <h4>{label}</h4>}
                      {values.length ? (
                        <ul>
                          {values.slice(0, group.fields.length > 1 ? 2 : 4).map((v) => (
                            <li key={v.value}>
                              <Link
                                href={taxonomyOverviewHref(group.id, field, v.value)}
                                title={`${v.count} benchmark ${v.count === 1 ? "family" : "families"}`}
                              >
                                <span>{v.label}</span>
                                <b>{v.count}</b>
                              </Link>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <Link
                          className="overview-unannotated"
                          href={taxonomyOverviewHref(group.id, field, "unlabeled")}
                        >
                          Not annotated
                        </Link>
                      )}
                    </div>
                  ))}
                </div>
                <Link className="overview-dimension-more" href={taxonomyOverviewHref(group.id)}>
                  Explore all values <IconChevron size={12} />
                </Link>
              </article>
            );
          })}
        </div>
      )}
      <p className="overview-discovery-note">
        Counts describe the product library and may overlap. Integration checks and local readiness
        are shown separately on each benchmark.
      </p>
    </section>
  );
}
