// Methods (design §9.16): the method lines Orbit has run (a method name over jobs), each content
// revision with what it is made of and where it came from, and its results per benchmark compared
// with the revision before it. Orbit records and compares; people and Agents decide what to change.
import {
  fmtCi,
  fmtMetric,
  type MetricDef,
  primaryMetric,
  resolveMetrics,
} from "@zjunlp/orbit/metrics";
import { IconBranch } from "../components/icons.tsx";
import { TopBar } from "../components/TopBar.tsx";
import { CopyButton, Empty, Link, Loading } from "../components/ui.tsx";
import { api, type MethodLine, type MethodRevisionEntry } from "../lib/api.ts";
import { ago, dateTime, jobPath, trialPath } from "../lib/format.ts";
import { setQuery, useLocation } from "../lib/router.ts";
import { useAsync } from "../lib/use.ts";
import "./hub.css";

const SCORE = primaryMetric(resolveMetrics([]));
type Result = MethodRevisionEntry["results"][number];

/** `codex · gpt-6.1-sol · high · cli 0.166.0 · bundle 1a2b3c` */
export function basisText(r: MethodRevisionEntry): string {
  const b = r.basis;
  return [
    b.agent,
    b.model ?? "default model",
    b.effort,
    b.cliVersion ? `cli ${b.cliVersion.replace(/^codex-cli /, "")}` : null,
    b.bundleDigest ? `bundle ${b.bundleDigest.slice(0, 8)}` : null,
    b.entrypoint,
    b.config ? `config ${Object.keys(b.config).length} keys` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Results of a line on one benchmark, oldest first: one point per job. */
export function benchmarkSeries(
  line: MethodLine,
  benchmark: string,
  condition?: string,
  taskSet?: string,
) {
  return line.revisions
    .flatMap((r) =>
      r.results
        .filter(
          (x) =>
            x.benchmark === benchmark &&
            (!condition || x.condition === condition) &&
            (!taskSet || x.taskSet === taskSet),
        )
        .map((x) => ({ r, x })),
    )
    .sort((a, b) => (a.x.at < b.x.at ? -1 : 1));
}

export function MethodsPage() {
  const loc = useLocation();
  const requestedMetric = loc.query.get("metric") ?? undefined;
  const methods = useAsync(() => api.methods(requestedMetric), [requestedMetric], {
    poll: true,
    pollMs: 15000,
  });
  const lines = (methods.data ?? []).filter((l) => l.revisions.length);
  const q = (loc.query.get("q") ?? "").toLowerCase();
  const shown = lines
    .filter((l) => `${l.name} ${l.agents.join(" ")}`.toLowerCase().includes(q))
    .sort((a, b) => ((a.revisions[0]?.firstAt ?? "") < (b.revisions[0]?.firstAt ?? "") ? 1 : -1));
  const selected = shown.find((l) => l.name === loc.query.get("m")) ?? shown[0];
  const revisions = lines.reduce((n, l) => n + l.revisions.length, 0);
  const derived = lines.reduce(
    (n, l) => n + l.revisions.filter((r) => r.lineage?.parent).length,
    0,
  );
  const compared = lines.reduce(
    (n, l) => n + l.revisions.flatMap((r) => r.results).filter((x) => x.versus).length,
    0,
  );
  return (
    <>
      <TopBar crumbs={[{ label: "Methods" }]}>
        <Link className="btn primary sm" href="/bench/new">
          New evaluation
        </Link>
      </TopBar>
      <div className="page">
        <div className="page-pad col" style={{ gap: 16 }}>
          {methods.error && !methods.data ? (
            <div className="callout" role="alert">
              {methods.error}
            </div>
          ) : !methods.data ? (
            <Loading what="Loading methods" />
          ) : !lines.length ? (
            <Empty title="No method has run yet" icon={<IconBranch size={36} />}>
              <p>
                A method is an Agent (or policy) with its model, settings and method bundle. Each
                change of what it is made of is a new revision; this page lines revisions up on the
                same benchmark so you can see whether a change helped.
              </p>
              <p>
                <Link className="btn primary" href="/bench/new">
                  Run a first evaluation
                </Link>
              </p>
            </Empty>
          ) : (
            <>
              <div className="hub-stats">
                <div className="hub-stat">
                  <b className="num">{lines.length}</b>
                  <span>method lines</span>
                  <small className="faint">a method name over evaluations</small>
                </div>
                <div className="hub-stat">
                  <b className="num">{revisions}</b>
                  <span>revisions</span>
                  <small className="faint">distinct content (model, CLI, bundle…)</small>
                </div>
                <div className="hub-stat">
                  <b className="num">{derived}</b>
                  <span>with a declared parent</span>
                  <small className="faint">lineage you recorded</small>
                </div>
                <div className="hub-stat good">
                  <b className="num">{compared}</b>
                  <span>paired comparisons</span>
                  <small className="faint">against the revision before</small>
                </div>
              </div>
              <div className="hub-layout">
                <aside className="facets" aria-label="Method lines">
                  <input
                    className="input"
                    type="search"
                    placeholder="Search methods"
                    aria-label="Search methods"
                    value={loc.query.get("q") ?? ""}
                    onChange={(e) => setQuery({ q: e.target.value || null })}
                  />
                  <div className="facet">
                    {shown.map((l) => (
                      <button
                        key={l.name}
                        type="button"
                        className={`facet-item tall${selected?.name === l.name ? " on" : ""}`}
                        onClick={() => setQuery({ m: l.name, b: null, c: null, tasks: null })}
                      >
                        <span className="col" style={{ gap: 1, minWidth: 0 }}>
                          <b className="ellipsis">{l.name}</b>
                          <small className="faint ellipsis">{l.agents.join(", ")}</small>
                        </span>
                        <span className="num faint">{l.revisions.length}</span>
                      </button>
                    ))}
                  </div>
                </aside>
                {selected ? <LineView line={selected} /> : <Empty title="No matching method" />}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function LineView({ line }: { line: MethodLine }) {
  const loc = useLocation();
  const benchmarks = [...new Set(line.revisions.flatMap((r) => r.results.map((x) => x.benchmark)))];
  const benchmark = benchmarks.includes(loc.query.get("b") ?? "")
    ? (loc.query.get("b") as string)
    : (benchmarks[0] ?? "");
  const all = benchmarkSeries(line, benchmark);
  const conditions = [...new Set(all.map(({ x }) => x.condition))];
  const condition = conditions.includes(loc.query.get("c") ?? "")
    ? (loc.query.get("c") ?? undefined)
    : all.at(-1)?.x.condition;
  const matching = all.filter(({ x }) => x.condition === condition);
  const taskSets = [...new Set(matching.map(({ x }) => x.taskSet))];
  const taskSet = taskSets.includes(loc.query.get("tasks") ?? "")
    ? (loc.query.get("tasks") ?? undefined)
    : matching.at(-1)?.x.taskSet;
  const series = benchmarkSeries(line, benchmark, condition, taskSet);
  const metric = series[0]?.x.metric ?? SCORE;
  const metrics = series[0]?.x.metrics ?? [SCORE];
  return (
    <div className="col" style={{ gap: 12, minWidth: 0 }}>
      <section className="card">
        <div className="card-h">
          <IconBranch size={14} /> {line.name}
          <span className="sub">
            {line.revisions.length} revision{line.revisions.length === 1 ? "" : "s"} ·{" "}
            {line.agents.join(", ")}
          </span>
          <span className="spacer" />
          <span className="seg">
            {benchmarks.map((b) => (
              <button
                key={b}
                type="button"
                className={`btn sm${b === benchmark ? " on" : " ghost"}`}
                aria-pressed={b === benchmark}
                onClick={() => setQuery({ b, c: null, tasks: null })}
              >
                {b}
              </button>
            ))}
          </span>
        </div>
        <div className="card-b">
          <div className="method-filters">
            {conditions.length > 1 && (
              <label>
                Evaluation conditions
                <select
                  aria-label="Evaluation conditions"
                  className="input"
                  value={condition}
                  onChange={(e) => setQuery({ c: e.target.value, tasks: null })}
                >
                  {conditions.map((c, i) => (
                    <option key={c} value={c}>
                      Conditions {i + 1} · {c.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {taskSets.length > 1 && (
              <label>
                Task set
                <select
                  aria-label="Task set"
                  className="input"
                  value={taskSet}
                  onChange={(e) => setQuery({ tasks: e.target.value })}
                >
                  {taskSets.map((t) => (
                    <option key={t} value={t}>
                      {matching.find(({ x }) => x.taskSet === t)?.x.tasks} tasks · {t.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Metric
              <select
                aria-label="Metric"
                className="input"
                value={metric.name}
                onChange={(e) => setQuery({ metric: e.target.value })}
              >
                {metrics.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <span className="faint">
              Valid trials · {metric.higherIsBetter ? "higher" : "lower"} is better
            </span>
          </div>
          <Trend series={series} metric={metric} />
          <p className="faint catalog-sub">
            Lines connect comparable results on the same task set. Dashed points are regression
            subsets; confirm improvements on the full set.
          </p>
        </div>
      </section>
      <section className="card">
        <div className="card-h">
          Revisions on {benchmark}
          <span className="sub">newest first · Δ is paired over tasks both revisions ran</span>
        </div>
        <div className="matrix-wrap">
          <table className="table hub-table method-table">
            <thead>
              <tr>
                <th>Revision</th>
                <th>Made of</th>
                <th>Lineage</th>
                <th className="r">{metric.label} ± 95% CI</th>
                <th className="r">Δ vs previous</th>
                <th className="r" />
              </tr>
            </thead>
            <tbody>
              {[...series].reverse().map(({ r, x }) => (
                <RevisionRow key={`${r.revision}/${x.job}`} r={r} x={x} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-h">Iterate</div>
        <div className="card-b iterate">
          <ol>
            <li>
              Open a failed trial from a revision's evaluation; invalid trials are infrastructure,
              fix and retry the same revision.
            </li>
            <li>
              On a valid failure, change the method (bundle, model, settings) and start an
              evaluation with <b>Derive next method</b> on the trial page, or <code>--parent</code>{" "}
              <code>--note</code> <code>--informed-by</code> on <code>orbit bench run</code>.
            </li>
            <li>
              Run the failed tasks first (marked <i>subset</i>), then the full set before claiming
              an improvement.
            </li>
          </ol>
        </div>
      </section>
    </div>
  );
}

function RevisionRow({ r, x }: { r: MethodRevisionEntry; x: Result }) {
  const metric = x.metric ?? SCORE;
  const s = x.summary.metrics[metric.name];
  const v = x.versus;
  const d = v?.diff;
  const direction = d?.ci && d.ci[0] > 0 ? 1 : d?.ci && d.ci[1] < 0 ? -1 : 0;
  const sign = direction === 0 ? "flat" : direction > 0 === metric.higherIsBetter ? "up" : "down";
  return (
    <tr>
      <td>
        <span className="mono rev">{r.revision}</span> <CopyButton text={r.revision} />
        {r.approximate && (
          <div
            className="faint catalog-sub"
            title="Some execution details were unavailable when this revision was recorded"
          >
            approximate
          </div>
        )}
        <div className="faint catalog-sub">{dateTime(x.at)}</div>
      </td>
      <td className="mono catalog-sub" style={{ whiteSpace: "normal" }}>
        {basisText(r)}
      </td>
      <td>
        {r.lineage?.parent ? (
          <span className="mono">← {r.lineage.parent}</span>
        ) : (
          <span className="faint">no parent recorded</span>
        )}
        {r.lineage?.note && <div className="catalog-sub">{r.lineage.note}</div>}
        {(r.lineage?.informedBy ?? []).map((t) => (
          <Link key={t} className="chip link mono" href={trialPath(t.split(".")[0] ?? "", t)}>
            {t.split(".").pop()}
          </Link>
        ))}
      </td>
      <td className="r num">
        {fmtMetric(s?.mean, metric)} <span className="faint">{fmtCi(s, metric)}</span>
        <div className="faint catalog-sub">
          {x.summary.valid}/{x.summary.trials} valid · {x.tasks} tasks
        </div>
      </td>
      <td className={`r num delta-${sign ?? "none"}`}>
        {v ? (
          <>
            {d ? fmtMetric(d.mean, metric, true) : "—"}
            <div className="faint catalog-sub">
              vs {v.revision.slice(0, 6)} · {v.pairedTasks} paired
              {v.subset && <span className="chip warn">subset</span>}
            </div>
          </>
        ) : (
          <span className="faint">no comparable earlier result</span>
        )}
      </td>
      <td className="r nowrap">
        <Link className="btn sm" href={resultHref(x)}>
          {x.reportRevision ? `Report r${x.reportRevision}` : "Evaluation"}
        </Link>
        {v && (
          <>
            <Link className="btn sm ghost" href={compareHref(x)}>
              Compare
            </Link>
            <Link className="btn sm ghost" href={compareHref(x, true)}>
              Regressions
            </Link>
          </>
        )}
      </td>
    </tr>
  );
}

export function compareHref(x: Result, regressions = false): string {
  const v = x.versus;
  if (!v) return resultHref(x);
  const q = new URLSearchParams({
    jobs: `${v.job},${x.job}`,
    baselineJob: v.job,
    baselineMethod: v.method,
    targetJob: x.job,
    targetMethod: x.method,
    metric: (x.metric ?? SCORE).name,
  });
  if (regressions) q.set("change", "regressed");
  return `/bench/compare?${q}`;
}

export function resultHref(x: Result): string {
  return `${jobPath(x.job)}${x.reportRevision ? `?report=${x.reportRevision}` : ""}`;
}

function Trend({
  series,
  metric,
}: {
  series: { r: MethodRevisionEntry; x: Result }[];
  metric: MetricDef;
}) {
  if (!series.length) return <p className="faint">No result on this benchmark.</p>;
  const W = 720;
  const H = 170;
  const P = 42;
  const values = series.flatMap(({ x }) => {
    const s = x.summary.metrics[metric.name];
    return s ? [s.mean, ...(s.ci ?? [])] : [];
  });
  const low = metric.range?.[0] ?? Math.min(0, ...values);
  const high = metric.range?.[1] ?? Math.max(low + 1, ...values);
  const y = (v: number) =>
    H - P - ((Math.max(low, Math.min(high, v)) - low) / (high - low)) * (H - 2 * P);
  const pts = series.map(({ r, x }, i) => {
    const s = x.summary.metrics[metric.name];
    return {
      r,
      x,
      px: series.length === 1 ? W / 2 : P + (i * (W - 2 * P)) / (series.length - 1),
      py: s ? y(s.mean) : null,
      lo: s?.ci ? y(s.ci[0]) : null,
      hi: s?.ci ? y(s.ci[1]) : null,
    };
  });
  let previous: string | null = null;
  const path = pts
    .map((p) => {
      if (p.py === null) {
        previous = null;
        return "";
      }
      const command = `${previous && p.x.versus?.job === previous ? "L" : "M"}${p.px},${p.py}`;
      previous = p.x.job;
      return command;
    })
    .join(" ");
  return (
    <svg
      className="trend"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`${metric.label} by evaluation`}
    >
      {[low, (low + high) / 2, high].map((v) => (
        <g key={v}>
          <line x1={P} x2={W - P} y1={y(v)} y2={y(v)} className="grid" />
          <text x={2} y={y(v) + 4} className="axis">
            {Number(v.toPrecision(3))}
            {metric.unit ?? ""}
          </text>
        </g>
      ))}
      <path d={path} className="line" />
      {pts.map((p) => (
        <g key={p.x.job + p.r.revision}>
          {p.lo !== null && p.hi !== null && (
            <line x1={p.px} x2={p.px} y1={p.lo} y2={p.hi} className="ci" />
          )}
          {p.py !== null && (
            <a
              href={resultHref(p.x)}
              aria-label={`${p.r.revision}: ${fmtMetric(p.x.summary.metrics[metric.name]?.mean, metric)}, open ${p.x.reportRevision ? `report revision ${p.x.reportRevision}` : "evaluation"}`}
            >
              <circle cx={p.px} cy={p.py} r={5} className={p.x.versus?.subset ? "pt subset" : "pt"}>
                <title>
                  {p.r.revision} · {fmtMetric(p.x.summary.metrics[metric.name]?.mean, metric)} ·{" "}
                  {p.x.summary.valid}/{p.x.summary.trials} valid · {ago(p.x.at)}
                </title>
              </circle>
            </a>
          )}
          <text x={p.px} y={H - 12} className="axis" textAnchor="middle">
            {p.r.revision.slice(0, 6)}
          </text>
        </g>
      ))}
    </svg>
  );
}
