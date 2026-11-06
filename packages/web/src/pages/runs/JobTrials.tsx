import { sampleLabel } from "@zjunlp/orbit/naming";
import { useMemo } from "react";
import { Link, stateColor } from "../../components/ui.tsx";
import { api, type Run, type Trial } from "../../lib/api.ts";
import { ago, duration, fmtScore, runDuration, trialPath } from "../../lib/format.ts";
import { navigate, onLinkClick } from "../../lib/router.ts";
import { useAsync } from "../../lib/use.ts";

import type { Job } from "./filters.tsx";
/** One row per trial: task, method, solve → verify states, score, evaluation. */
export function JobTrials({ job, runs, now }: { job: Job; runs: Run[]; now: number }) {
  const byId = useMemo(() => new Map(runs.map((r) => [r.id, r])), [runs]);
  const states = runs.map((r) => r.state).join(",");
  const d = useAsync(() => api.benchJob(job.id), [job.id, states]);
  if (!d.data)
    return (
      <tr>
        <td />
        <td colSpan={8} className="faint" style={{ paddingLeft: 40 }}>
          {d.error ?? "Loading trials…"}
        </td>
      </tr>
    );
  return (
    <>
      {d.data.trials.map((t) => (
        <TrialRow
          key={t.id}
          t={t}
          seeds={job.spec.seeds ?? 1}
          solve={byId.get(t.solveRunId ?? "")}
          verify={byId.get(t.verifyRunId ?? "")}
          now={now}
        />
      ))}
    </>
  );
}

function PhaseDot({ run, label }: { run: Run | undefined; label: string }) {
  return (
    <span className="row" style={{ gap: 4 }} title={`${label}: ${run ? run.state : "not started"}`}>
      <span
        className="dot"
        style={
          { "--c": run ? stateColor(run.state) : "var(--border-strong)" } as React.CSSProperties
        }
      />
      <span className="faint" style={{ fontSize: 11 }}>
        {label}
      </span>
    </span>
  );
}

function TrialRow(props: { t: Trial; seeds: number; solve?: Run; verify?: Run; now: number }) {
  const { t, solve, verify } = props;
  const o = t.outcome;
  const href = trialPath(t.jobId, t.id);
  const ev = o?.evaluation;
  return (
    <tr className="click trial-row" onClick={() => navigate(href)}>
      <td />
      <td>
        <div className="row" style={{ gap: 8 }}>
          <PhaseDot run={solve} label="solve" />
          <PhaseDot run={verify} label="verify" />
        </div>
      </td>
      <td>
        <div className="row" style={{ gap: 8, paddingLeft: 18 }}>
          <Link
            href={href}
            className="mono"
            style={{ color: "var(--text)" }}
            onClick={(e) => {
              e.stopPropagation();
              onLinkClick(e);
            }}
          >
            {t.task}
          </Link>
          <span className="muted">{t.method}</span>
          {(t.sampleRef || props.seeds > 1) && <span className="faint">#{sampleLabel(t)}</span>}
        </div>
      </td>
      <td colSpan={3}>
        {o && o.score !== null && (
          <span className="num">
            <b>{fmtScore(o.score)}</b>
            <span className="faint"> / {fmtScore(o.maxScore)}</span>
          </span>
        )}{" "}
        {ev && (
          <span className={`chip ${ev === "valid" ? "good" : ev === "invalid" ? "bad" : "warn"}`}>
            {ev}
          </span>
        )}{" "}
        {(o?.issues ?? t.issues).length > 0 && (
          <span
            className="faint ellipsis"
            style={{ fontSize: 12 }}
            title={(o?.issues ?? t.issues).join("\n")}
          >
            {(o?.issues ?? t.issues)[0]}
          </span>
        )}
      </td>
      <td />
      <td className="muted">{ago(t.createdAt, props.now)}</td>
      <td className="r num muted">{duration(solve ? runDuration(solve, props.now) : null)}</td>
    </tr>
  );
}
