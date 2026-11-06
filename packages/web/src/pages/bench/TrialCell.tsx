import { type MetricDef, metricValue } from "@zjunlp/orbit/metrics";
import { sampleLabel } from "@zjunlp/orbit/naming";
import { ScoreCell } from "../../components/BenchMetrics.tsx";
import { Link } from "../../components/ui.tsx";
import type { Trial } from "../../lib/api.ts";
import { fmtScore, runPath, trialPath } from "../../lib/format.ts";

export function RunLinks({ t }: { t: Trial }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      {t.solveRunId && (
        <Link className="chip link mono" href={runPath(t.solveRunId)}>
          solve
        </Link>
      )}
      {t.verifyRunId && (
        <Link className="chip link mono" href={runPath(t.verifyRunId)}>
          verify
        </Link>
      )}
    </span>
  );
}

export function TrialCell({ t, seeds, metric }: { t: Trial; seeds: number; metric: MetricDef }) {
  const o = t.outcome;
  const phase = t.state === "done" ? null : t.history.length ? "rescoring" : t.state;
  const title = [
    `${t.task} · ${t.method}${t.sampleRef || seeds > 1 ? ` #${sampleLabel(t)}` : ""}`,
    phase ? `state: ${phase}` : `evaluation: ${o?.evaluation} · execution: ${o?.execution}`,
    o && o.score !== null ? `score: ${fmtScore(o.score)} / ${fmtScore(o.maxScore)}` : null,
    ...Object.entries(o?.metrics ?? {}).map(([k, v]) => `${k}: ${fmtScore(v)}`),
    ...(o?.issues ?? t.issues),
    t.history.length
      ? `rescored; earlier: ${t.history.map((h) => fmtScore(h.outcome.score)).join(", ")}`
      : null,
    o?.cleanup === "failed" ? "cleanup failed" : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <ScoreCell
      value={metricValue(o, metric.name)}
      metric={metric}
      evaluation={o ? o.evaluation : "pending"}
      href={trialPath(t.jobId, t.id)}
      title={title}
      note={
        phase === "verifying"
          ? "verify"
          : t.sampleRef || seeds > 1
            ? `#${sampleLabel(t)}`
            : undefined
      }
    />
  );
}
