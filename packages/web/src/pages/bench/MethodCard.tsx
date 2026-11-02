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
