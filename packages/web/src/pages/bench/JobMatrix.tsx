import { fmtCi, type MetricDef } from "@zjunlp/orbit/metrics";
import { useMemo } from "react";
import { ciTitle, MetricSwitch, ScoreCell } from "../../components/BenchMetrics.tsx";
import type { BenchJob, MethodSummary, Trial } from "../../lib/api.ts";

import { TrialCell } from "./TrialCell.tsx";

/** Solve resources a task ran with when the benchmark has a resources file. */
function resourceTitle(r: Record<string, number | undefined> | undefined): string | undefined {
  if (!r) return undefined;
  const parts = Object.entries(r)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  return parts.length ? `solve resources: ${parts.join(", ")}` : undefined;
}

export function JobMatrix({
  job,
  trials,
  summary,
  metric,
  metrics,
  setMetric,
}: {
  job: BenchJob;
  trials: Trial[];
  summary: MethodSummary[];
  metric: MetricDef;
  metrics: MetricDef[];
  setMetric: (name: string) => void;
}) {
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
  return (
    <section className="card">
      <div className="card-h">
        {metric.label}{" "}
        <span className="sub">
          per trial{metric.description ? ` · ${metric.description}` : ""} · click a cell for the
          trial
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
                        <TrialCell key={t.id} t={t} seeds={job.spec.seeds ?? 1} metric={metric} />
                      ))}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
            <tr className="mean">
              <td>Mean over tasks</td>
              {summary.map((s) => {
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
  );
}
