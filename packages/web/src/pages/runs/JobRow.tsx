import { fmtMetric, primaryMetric, resolveMetrics } from "@zjunlp/orbit/metrics";
import { IconChevron, IconChevronDown, IconFlask } from "../../components/icons.tsx";
import { Link } from "../../components/ui.tsx";
import type { Run } from "../../lib/api.ts";
import { ago, dateTime, duration } from "../../lib/format.ts";
import { onLinkClick } from "../../lib/router.ts";

import type { Job } from "./filters.tsx";
import { JobTrials } from "./JobTrials.tsx";
import { AgentCell } from "./RunRow.tsx";
/** A bench job in the run list: progress and method means; expands to its trials. */
export function JobRow(props: {
  job: Job;
  runs: Run[];
  expanded: boolean;
  cursor: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onHover: () => void;
  now: number;
}) {
  const { job, runs } = props;
  const metric = primaryMetric(resolveMetrics(job.metrics));
  const trials = job.summary.reduce((a, s) => a + s.trials, 0);
  const pending = job.summary.reduce((a, s) => a + s.pending, 0);
  const done = trials - pending;
  const starts = runs
    .map((r) => r.startedAt)
    .filter(Boolean)
    .map((t) => Date.parse(t as string));
  const end = job.endedAt ? Date.parse(job.endedAt) : props.now;
  const cls = ["click", "group-row", "job-row", props.cursor && "cursor", props.selected && "sel"]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <tr className={cls} onClick={props.onToggle} onMouseMove={props.onHover}>
        <td onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            className="check"
            checked={props.selected}
            onChange={props.onSelect}
          />
        </td>
        <td>
          <div className="row" style={{ gap: 6 }} title={`${done}/${trials} trials done`}>
            <div className="stackbar">
              <span
                style={
                  {
                    "--c": "var(--st-succeeded)",
                    width: `${(100 * done) / Math.max(1, trials)}%`,
                  } as React.CSSProperties
                }
              />
              <span
                style={
                  {
                    "--c": job.state === "running" ? "var(--st-running)" : "var(--st-cancelled)",
                    width: `${(100 * pending) / Math.max(1, trials)}%`,
                  } as React.CSSProperties
                }
              />
            </div>
          </div>
        </td>
        <td>
          <div className="row" style={{ gap: 6 }}>
            {props.expanded ? <IconChevronDown size={14} /> : <IconChevron size={14} />}
            <IconFlask size={14} style={{ color: "var(--accent)" }} />
            <Link
              href={`/bench/${encodeURIComponent(job.id)}`}
              className="ellipsis"
              style={{ color: "var(--text)", fontWeight: 500 }}
              onClick={(e) => {
                e.stopPropagation();
                onLinkClick(e);
              }}
            >
              {job.spec.name ?? job.id}
            </Link>
            <span className="chip mono">{job.spec.benchmark}</span>
            <span className="chip">
              {done}/{trials} trials
            </span>
            {job.state !== "done" && <span className="faint">{job.state}</span>}
          </div>
        </td>
        <td colSpan={3}>
          <span className="params">
            {job.summary.map((s) => (
              <span
                key={s.method}
                className="param"
                title={`${metric.label} · ${s.valid} valid · ${s.invalid} invalid · ${s.unknown} unknown`}
              >
                <i>{s.method}</i> {fmtMetric(s.metrics[metric.name]?.mean, metric)}
                {s.invalid + s.unknown > 0 && (
                  <span className="faint"> ({s.invalid + s.unknown} not valid)</span>
                )}
              </span>
            ))}
          </span>
        </td>
        <td>{runs[0] && <AgentCell run={runs[0]} />}</td>
        <td className="muted" title={dateTime(job.createdAt)}>
          {ago(job.createdAt, props.now)}
        </td>
        <td className="r num muted">
          {duration(starts.length ? end - Math.min(...starts) : null)}
        </td>
      </tr>
      {props.expanded && <JobTrials job={job} runs={runs} now={props.now} />}
    </>
  );
}
