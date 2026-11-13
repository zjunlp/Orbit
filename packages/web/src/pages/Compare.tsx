import { useEffect, useMemo, useState } from "react";
import { Chart, type ChartSeries, PALETTE } from "../components/Chart.tsx";
import { IconCompare, IconLayers, IconStar } from "../components/icons.tsx";
import { keyMatcher, MetricControls, type MetricView } from "../components/MetricControls.tsx";
import { TopBar } from "../components/TopBar.tsx";
import { Empty, Link, Loading, StateBadge, StateIcon } from "../components/ui.tsx";
import { api, type Metrics, type Run } from "../lib/api.ts";
import { stats } from "../lib/ema.ts";
import {
  ago,
  duration,
  formatTokens,
  isActive,
  num,
  runDuration,
  runPath,
  runTitle,
  shellQuote,
} from "../lib/format.ts";
import { setQuery, useLocation } from "../lib/router.ts";
import { upsertRun, useRuns, useRunsState } from "../lib/runs-store.ts";

const MAX_RUNS = 40;
const lowerIsBetter = (k: string) =>
  /loss|err|perplex|ppl|mse|mae|rmse|time|latency|wer|cer/i.test(k);

interface Row {
  key: string;
  label: string;
  color: string;
  runs: Run[];
  params: Record<string, string>;
  summary: Record<string, { mean: number; std: number; n: number }>;
}

export function Compare() {
  const loc = useLocation();
  const all = useRuns();
  const { loaded, runs: byId } = useRunsState();
  const idsParam = loc.query.get("ids");
  const group = loc.query.get("group");
  const baseId = loc.query.get("base");
  // Seeds are averaged by default when they vary; ?agg=none shows every run.
  const agg = loc.query.get("agg");

  const runs = useMemo(() => {
    let list: Run[] = [];
    if (idsParam) {
      const ids = idsParam.split(",").filter(Boolean);
      list = ids.map((id) => byId.get(id)).filter((r): r is Run => Boolean(r));
    } else if (group) list = all.filter((r) => r.spec.group === group).reverse();
    return list.slice(0, MAX_RUNS);
  }, [all, byId, idsParam, group]);

  // Runs older than the live list's window are fetched once by id.
  const [tried] = useState(() => new Set<string>());
  useEffect(() => {
    if (!loaded || !idsParam) return;
    for (const id of idsParam.split(",").filter(Boolean).slice(0, MAX_RUNS)) {
      if (byId.has(id) || tried.has(id)) continue;
      tried.add(id);
      api.run(id).then(upsertRun, () => undefined);
    }
  }, [loaded, idsParam, byId, tried]);

  const [metrics, setMetrics] = useState<Record<string, Metrics>>({});
  const runKey = runs.map((r) => `${r.id}:${r.state}`).join(",");
  const anyActive = runs.some((r) => isActive(r.state));
  const [tick, setTick] = useState(0);
  // Refetch when membership or states change, and every few seconds while a run is active; the
  // next refresh starts only after the previous one finished.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by runKey and tick
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ids = runs.map((r) => r.id);
    const out: Record<string, Metrics> = {};
    const worker = async () => {
      for (let id = ids.shift(); id !== undefined; id = ids.shift()) {
        const m = await api.metrics(id).catch(() => null);
        if (m) out[id] = m;
      }
    };
    void Promise.all(Array.from({ length: 6 }, worker)).then(() => {
      if (!live) return;
      setMetrics(out);
      if (anyActive) timer = setTimeout(() => setTick((t) => t + 1), 5000);
    });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [runKey, tick]);

  const [view, setView] = useState<MetricView>({ filter: "", smoothing: 0.6, logY: false });
  const [onlyDiff, setOnlyDiff] = useState(true);

  const paramKeys = useMemo(
    () => [...new Set(runs.flatMap((r) => Object.keys(r.spec.params)))],
    [runs],
  );
  const varying = useMemo(
    () => paramKeys.filter((k) => new Set(runs.map((r) => r.spec.params[k] ?? "")).size > 1),
    [paramKeys, runs],
  );
  const aggKey =
    agg === null
      ? varying.includes("seed") && varying.length > 1
        ? "seed"
        : ""
      : paramKeys.includes(agg)
        ? agg
        : "";

  const base = runs.find((r) => r.id === baseId) ?? runs[0];
  const colorOf = useMemo(
    () => new Map(runs.map((r, i) => [r.id, PALETTE[i % PALETTE.length] as string])),
    [runs],
  );

  const metricKeys = useMemo(() => {
    const ks = new Set<string>();
    for (const r of runs) for (const s of metrics[r.id]?.series ?? []) ks.add(s.key);
    const match = keyMatcher(view.filter);
    return [...ks].filter(match).sort();
  }, [runs, metrics, view.filter]);

  const rows = useMemo<Row[]>(() => {
    const groups = new Map<string, Run[]>();
    for (const r of runs) {
      const k = aggKey
        ? varying
            .filter((p) => p !== aggKey)
            .map((p) => `${p}=${r.spec.params[p] ?? ""}`)
            .join(" ") || "all"
        : r.id;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    return [...groups.entries()].map(([k, rs], i) => {
      const summary: Row["summary"] = {};
      for (const mk of metricKeys) {
        const vals = rs
          .map((r) => metrics[r.id]?.summary[mk])
          .filter((v): v is number => v !== undefined);
        if (!vals.length) continue;
        const s = stats(vals);
        summary[mk] = { mean: s.mean, std: s.std, n: vals.length };
      }
      const first = rs[0] as Run;
      return {
        key: k,
        label: aggKey ? k : runTitle(first),
        color: aggKey ? (PALETTE[i % PALETTE.length] as string) : (colorOf.get(first.id) as string),
        runs: rs,
        params: aggKey
          ? Object.fromEntries(
              varying.filter((p) => p !== aggKey).map((p) => [p, first.spec.params[p] ?? ""]),
            )
          : first.spec.params,
        summary,
      };
    });
  }, [runs, aggKey, varying, metricKeys, metrics, colorOf]);

  const baseRow = rows.find((r) => r.runs.some((x) => x.id === base?.id)) ?? rows[0];

  if (!idsParam && !group) return <ComparePicker runs={all} />;
  if (!loaded) return <Loading />;

  const title = group ?? `${runs.length} runs`;
  const tableKeys = metricKeys.slice(0, 12);
  return (
    <>
      <TopBar crumbs={[{ label: "Compare", href: "/compare" }, { label: title }]}>
        {paramKeys.length > 0 && (
          <label className="row muted" style={{ gap: 6, fontSize: 12 }}>
            Aggregate over
            <select
              className="input"
              style={{ height: 26 }}
              value={aggKey}
              onChange={(e) => setQuery({ agg: e.target.value || "none" })}
            >
              <option value="">— none —</option>
              {paramKeys.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
        )}
      </TopBar>
      <MetricControls view={view} set={(p) => setView({ ...view, ...p })}>
        <span className="faint" style={{ fontSize: 12 }}>
          {runs.length} runs{runs.length === MAX_RUNS ? " (max)" : ""}
          {aggKey && ` → ${rows.length} groups (mean ± std over ${aggKey})`}
        </span>
      </MetricControls>
      <div className="page">
        <div className="page-pad col" style={{ gap: 16 }}>
          {runs.length === 0 ? (
            <Empty title="No runs to compare" />
          ) : (
            <>
              <section className="card" style={{ overflow: "auto" }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 30 }} title="Baseline for deltas">
                        <IconStar size={12} />
                      </th>
                      <th>{aggKey ? "Group" : "Run"}</th>
                      {varying
                        .filter((p) => p !== aggKey)
                        .map((p) => (
                          <th key={p}>{p}</th>
                        ))}
                      <th>Tokens</th>
                      {tableKeys.map((k) => (
                        <th
                          key={k}
                          className="r"
                          title={lowerIsBetter(k) ? "lower is better" : "higher is better"}
                        >
                          {k} {lowerIsBetter(k) ? "↓" : "↑"}
                        </th>
                      ))}
                      {!aggKey && <th className="r">Duration</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const isBase = row === baseRow;
                      const first = row.runs[0] as Run;
                      return (
                        <tr key={row.key} className={isBase ? "sel" : ""}>
                          <td>
                            <button
                              type="button"
                              className="btn ghost sm icon"
                              title="Use as baseline"
                              onClick={() => setQuery({ base: first.id })}
                              style={{ color: isBase ? "var(--st-cancelled)" : undefined }}
                            >
                              <IconStar size={13} fill={isBase ? "currentColor" : "none"} />
                            </button>
                          </td>
                          <td>
                            <div className="row" style={{ gap: 8 }}>
                              <span
                                style={{
                                  width: 10,
                                  height: 10,
                                  borderRadius: 3,
                                  background: row.color,
                                  flex: "none",
                                }}
                              />
                              {aggKey ? (
                                <>
                                  <span>{row.label}</span>
                                  <span className="row" style={{ gap: 3 }}>
                                    {row.runs.map((r) => (
                                      <Link
                                        key={r.id}
                                        href={`${runPath(r.id)}`}
                                        title={`${aggKey}=${r.spec.params[aggKey]} · ${r.state}`}
                                      >
                                        <StateIcon state={r.state} size={12} />
                                      </Link>
                                    ))}
                                  </span>
                                </>
                              ) : (
                                <>
                                  <StateIcon state={first.state} size={12} />
                                  <Link
                                    href={`${runPath(first.id)}`}
                                    style={{ color: "var(--text)" }}
                                    className="ellipsis"
                                  >
                                    {row.label}
                                  </Link>
                                </>
                              )}
                            </div>
                          </td>
                          {varying
                            .filter((p) => p !== aggKey)
                            .map((p) => (
                              <td key={p} className="mono">
                                {row.params[p] ?? "—"}
                              </td>
                            ))}
                          <td>
                            {row.runs.map((run) => (
                              <div key={run.id} title={`${run.id}: ${formatTokens(run.tokens)}`}>
                                {formatTokens(run.tokens, true)}
                              </div>
                            ))}
                          </td>
                          {tableKeys.map((k) => (
                            <MetricCell
                              key={k}
                              k={k}
                              v={row.summary[k]}
                              base={isBase ? undefined : baseRow?.summary[k]}
                              showStd={Boolean(aggKey)}
                            />
                          ))}
                          {!aggKey && (
                            <td className="r num muted">{duration(runDuration(first))}</td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {metricKeys.length > tableKeys.length && (
                  <div className="card-b faint">
                    Showing 12 of {metricKeys.length} metrics — filter above to choose.
                  </div>
                )}
              </section>

              {metricKeys.length > 0 && (
                <div className="charts">
                  {metricKeys.map((k) => (
                    <CompareChart
                      key={k}
                      k={k}
                      rows={rows}
                      metrics={metrics}
                      view={view}
                      aggregate={Boolean(aggKey)}
                      colorOf={colorOf}
                    />
                  ))}
                </div>
              )}
              {metricKeys.length === 0 && Object.keys(metrics).length === runs.length && (
                <Empty title="These runs recorded no metrics" />
              )}
              {!aggKey && (
                <ConfigDiff
                  runs={runs}
                  base={base}
                  colorOf={colorOf}
                  onlyDiff={onlyDiff}
                  setOnlyDiff={setOnlyDiff}
                />
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function MetricCell({
  k,
  v,
  base,
  showStd,
}: {
  k: string;
  v?: { mean: number; std: number; n: number };
  base?: { mean: number };
  showStd: boolean;
}) {
  if (!v) return <td className="r faint">—</td>;
  let delta: React.ReactNode = null;
  if (base && Number.isFinite(base.mean) && base.mean !== 0) {
    const d = (v.mean - base.mean) / Math.abs(base.mean);
    const better = lowerIsBetter(k) ? d < 0 : d > 0;
    if (Math.abs(d) >= 0.0005)
      delta = (
        <span
          style={{ color: better ? "var(--add-fg)" : "var(--del-fg)", fontSize: 11, marginLeft: 6 }}
        >
          {d > 0 ? "+" : ""}
          {(d * 100).toFixed(1)}%
        </span>
      );
  }
  return (
    <td className="r mono num">
      {num(v.mean)}
      {showStd && v.n > 1 && <span className="faint"> ±{num(v.std)}</span>}
      {delta}
    </td>
  );
}

function meanCurve(series: [number, number][][]): [number, number][] {
  if (!series.length) return [];
  const maps = series.map((s) => new Map(s));
  const steps = [...(maps[0] as Map<number, number>).keys()].filter((x) =>
    maps.every((m) => m.has(x)),
  );
  return steps.map((x) => [x, maps.reduce((a, m) => a + (m.get(x) as number), 0) / maps.length]);
}

function CompareChart(props: {
  k: string;
  rows: Row[];
  metrics: Record<string, Metrics>;
  view: MetricView;
  aggregate: boolean;
  colorOf: Map<string, string>;
}) {
  const { k, rows, metrics, view, aggregate } = props;
  const [hover, setHover] = useState<{
    step: number | null;
    vals: { label: string; color: string; value: number | null }[];
  }>({ step: null, vals: [] });
  const series = useMemo<ChartSeries[]>(() => {
    const out: ChartSeries[] = [];
    for (const row of rows) {
      const pts = row.runs
        .map((r) => metrics[r.id]?.series.find((s) => s.key === k)?.points)
        .filter((p): p is [number, number][] => Boolean(p));
      if (!pts.length) continue;
      if (aggregate) {
        for (const [i, p] of pts.entries())
          out.push({ label: `${row.label} #${i}`, color: row.color, points: p, faint: true });
        out.push({ label: row.label, color: row.color, points: meanCurve(pts), emphasis: true });
      } else out.push({ label: row.label, color: row.color, points: pts[0] as [number, number][] });
    }
    return out;
  }, [rows, metrics, k, aggregate]);
  if (!series.length) return null;
  const shown = hover.vals
    .filter((v) => v.value !== null && !/ #\d+$/.test(v.label))
    .sort((a, b) => (b.value as number) - (a.value as number));
  return (
    <div className="card chart-card">
      <div className="card-h">
        <span className="mono">{k}</span>
        <span className="hover-val">{hover.step !== null ? `step ${num(hover.step)}` : ""}</span>
      </div>
      <div className="plot">
        <Chart
          series={series}
          smoothing={view.smoothing}
          logY={view.logY}
          syncKey="compare"
          onHover={(vals, step) => setHover({ vals, step })}
        />
      </div>
      <div className="legend" style={{ padding: "4px 12px 10px", minHeight: 26 }}>
        {(hover.step !== null ? shown : series.filter((s) => !s.faint)).slice(0, 8).map((s) => (
          <span key={s.label} style={{ "--c": s.color } as React.CSSProperties}>
            <i />
            <span className="ellipsis" style={{ maxWidth: 180 }}>
              {s.label}
            </span>
            {"value" in s && <b className="mono">{num(s.value as number)}</b>}
          </span>
        ))}
      </div>
    </div>
  );
}

function configRows(r: Run): Record<string, string> {
  const s = r.spec;
  const out: Record<string, string> = {
    command: shellQuote(s.command),
    image: r.image ?? s.image ?? s.dockerfile ?? "",
    resources: `${s.resources.gpus} GPU · ${s.resources.cpus} CPU · ${s.resources.memGB} GB`,
    commit: r.code ? `${r.code.branch ?? ""}@${r.code.commit?.slice(0, 10) ?? "none"}` : "—",
    "uncommitted files": r.code?.changedFiles.join(", ") || "—",
    state: r.state,
    exit: r.exitCode === null ? "—" : String(r.exitCode),
    agent: r.spec.agent
      ? `${r.spec.agent.harness} ${r.spec.agent.sessionId?.slice(0, 8) ?? ""}`
      : "—",
  };
  for (const [k, v] of Object.entries(s.params)) out[`param ${k}`] = v;
  for (const [k, v] of Object.entries(s.env)) out[`env ${k}`] = v;
  for (const [k, v] of Object.entries(s.tags)) out[`tag ${k}`] = v;
  return out;
}

function ConfigDiff({
  runs,
  base,
  colorOf,
  onlyDiff,
  setOnlyDiff,
}: {
  runs: Run[];
  base: Run | undefined;
  colorOf: Map<string, string>;
  onlyDiff: boolean;
  setOnlyDiff: (b: boolean) => void;
}) {
  const cfg = runs.map(configRows);
  const keys = [...new Set(cfg.flatMap((c) => Object.keys(c)))];
  const differs = (k: string) => new Set(cfg.map((c) => c[k] ?? "")).size > 1;
  const shown = onlyDiff ? keys.filter(differs) : keys;
  const bi = Math.max(
    0,
    runs.findIndex((r) => r.id === base?.id),
  );
  return (
    <section className="card" style={{ overflow: "auto" }}>
      <div className="card-h">
        Configuration
        <span className="sub">{keys.filter(differs).length} fields differ</span>
        <div className="spacer" />
        <div className="seg">
          <button type="button" className={onlyDiff ? "on" : ""} onClick={() => setOnlyDiff(true)}>
            Only differences
          </button>
          <button type="button" className={onlyDiff ? "" : "on"} onClick={() => setOnlyDiff(false)}>
            All fields
          </button>
        </div>
      </div>
      {shown.length === 0 ? (
        <div className="card-b faint">All compared fields are identical.</div>
      ) : (
        <table className="table compact">
          <thead>
            <tr>
              <th>Field</th>
              {runs.map((r) => (
                <th key={r.id} style={{ textTransform: "none", letterSpacing: 0 }}>
                  <span className="row" style={{ gap: 6 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        background: colorOf.get(r.id),
                      }}
                    />
                    <span className="ellipsis" style={{ maxWidth: 160 }}>
                      {runTitle(r)}
                    </span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((k) => (
              <tr key={k}>
                <td className="muted">{k}</td>
                {cfg.map((c, i) => {
                  const v = c[k] ?? "—";
                  const diff = i !== bi && v !== (cfg[bi]?.[k] ?? "—");
                  return (
                    <td
                      key={String(i)}
                      className="mono"
                      title={v}
                      style={{ background: diff ? "var(--mark)" : undefined, maxWidth: 260 }}
                    >
                      {v}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ComparePicker({ runs }: { runs: Run[] }) {
  const groups = useMemo(() => {
    const m = new Map<string, Run[]>();
    for (const r of runs)
      if (r.spec.group) m.set(r.spec.group, [...(m.get(r.spec.group) ?? []), r]);
    return [...m.entries()];
  }, [runs]);
  return (
    <>
      <TopBar crumbs={[{ label: "Compare" }]} />
      <div className="page">
        <div className="page-pad">
          {groups.length === 0 ? (
            <Empty title="Nothing to compare yet" icon={<IconCompare size={30} />}>
              <p>
                Launch a sweep (
                <code>orbit sweep -p seed=1,2,3 -- python train.py --seed {"{seed}"}</code>) or
                select runs with <code>x</code> in the Runs list.
              </p>
            </Empty>
          ) : (
            <>
              <p className="muted" style={{ marginTop: 0 }}>
                Pick a group, or select individual runs with <kbd>x</kbd> in the Runs list and press{" "}
                <kbd>c</kbd>.
              </p>
              <div className="gpus">
                {groups.map(([g, rs]) => (
                  <Link
                    key={g}
                    href={`/compare?group=${encodeURIComponent(g)}`}
                    className="gpu"
                    style={{ color: "var(--text)", textDecoration: "none" }}
                  >
                    <div className="row">
                      <IconLayers size={15} />
                      <b className="ellipsis">{g}</b>
                    </div>
                    <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                      {rs.slice(0, 24).map((r) => (
                        <StateIcon key={r.id} state={r.state} size={12} />
                      ))}
                    </div>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {rs.length} runs · {ago(rs[0]?.createdAt)}
                    </div>
                  </Link>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

export { StateBadge };
