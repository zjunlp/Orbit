import { fmtMetric, type MetricDef } from "@zjunlp/orbit/metrics";
import { ciTitle, StatValue } from "../../components/BenchMetrics.tsx";
import type { BenchJob, MethodSummary } from "../../lib/api.ts";

import { EvalBar, summaryTitle } from "./common.tsx";
/** A method's headline: the selected metric ± CI, its gap to the reference, the other metrics. */
export function MethodCard({
  s,
  method,
  metric,
  others,
  official,
}: {
  s: MethodSummary;
  method: BenchJob["spec"]["methods"][number] | undefined;
  metric: MetricDef;
  others: MetricDef[];
  /** The benchmark's own rule, to label the official value; absent when none is declared. */
  official?: BenchJob["official"];
}) {
  const off = s.official;
  const offMetric = off
    ? (others.find((m) => m.name === off.metric) ?? (metric.name === off.metric ? metric : null))
    : null;
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
            {method.entrypoint ? ` · ${method.entrypoint}` : ""}
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
        {s.valid}/{s.trials} valid · {s.invalid} invalid · {s.unknown} unknown
        {s.pending ? ` · ${s.pending} pending` : ""}
      </span>
      <span className="l">
        Orbit: valid trials only · {st?.tasks ?? 0} tasks · mean over tasks
        {s.pending ? " · provisional" : ""}
      </span>
      {off && official && (
        <span
          className="l"
          title={`${official.name}${official.version ? ` ${official.version}` : ""}: invalid trials ${official.errors === "fail" ? `count as ${official.failValue}` : "are left out"}; mean over ${official.unit}s. Cancelled or unfinished samples are missing.`}
        >
          Official ({official.name}):{" "}
          <b>
            {off.value === null
              ? "—"
              : offMetric
                ? fmtMetric(off.value, offMetric)
                : off.value.toFixed(2)}
          </b>{" "}
          over {off.samples} samples{off.partial ? ` · partial, ${off.missing} missing` : ""}
        </span>
      )}
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
