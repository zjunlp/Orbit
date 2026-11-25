import { IconChevron, IconChevronDown, IconCompare, IconLayers } from "../../components/icons.tsx";
import { Link, stateColor } from "../../components/ui.tsx";
import type { Run } from "../../lib/api.ts";
import { ago, duration, isActive, STATE_LABEL, STATES } from "../../lib/format.ts";
import { onLinkClick } from "../../lib/router.ts";

import { AgentCell, CodeCell } from "./RunRow.tsx";
export function GroupRow(props: {
  name: string;
  runs: Run[];
  expanded: boolean;
  cursor: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onHover: () => void;
  now: number;
}) {
  const { runs } = props;
  const byState = STATES.map((s) => [s, runs.filter((r) => r.state === s).length] as const).filter(
    ([, n]) => n,
  );
  const keys = [...new Set(runs.flatMap((r) => Object.keys(r.spec.params)))];
  const varying = keys.filter((k) => new Set(runs.map((r) => r.spec.params[k])).size > 1);
  const starts = runs
    .map((r) => r.startedAt)
    .filter(Boolean)
    .map((s) => Date.parse(s as string));
  const ends = runs.map((r) =>
    r.endedAt ? Date.parse(r.endedAt) : isActive(r.state) ? props.now : Number.NaN,
  );
  const span = starts.length
    ? Math.max(...ends.filter(Number.isFinite)) - Math.min(...starts)
    : null;
  const newest = runs[0];
  const cls = ["click", "group-row", props.cursor && "cursor", props.selected && "sel"]
    .filter(Boolean)
    .join(" ");
  return (
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
        <div
          className="row"
          style={{ gap: 6 }}
          title={byState.map(([s, n]) => `${n} ${STATE_LABEL[s]}`).join(", ")}
        >
          <div className="stackbar">
            {byState.map(([s, n]) => (
              <span
                key={s}
                style={
                  {
                    "--c": stateColor(s),
                    width: `${(n / runs.length) * 100}%`,
                  } as React.CSSProperties
                }
              />
            ))}
          </div>
        </div>
      </td>
      <td>
        <div className="row" style={{ gap: 6 }}>
          {props.expanded ? <IconChevronDown size={14} /> : <IconChevron size={14} />}
          <IconLayers size={14} style={{ color: "var(--text-3)" }} />
          <span className="ellipsis" title={props.name}>
            {props.name}
          </span>
          <span className="chip">{runs.length} runs</span>
          {byState
            .filter(([s]) => s === "failed" || s === "running" || s === "queued")
            .map(([s, n]) => (
              <span
                key={s}
                className="faint state-count"
                style={{ color: stateColor(s), fontWeight: 400, fontSize: 12 }}
              >
                {n} {STATE_LABEL[s].toLowerCase()}
              </span>
            ))}
        </div>
      </td>
      <td>
        {varying.length > 0 && (
          <span className="params">
            {varying.map((k) => (
              <span key={k} className="param">
                <i>{k}</i> ×{new Set(runs.map((r) => r.spec.params[k])).size}
              </span>
            ))}
          </span>
        )}
      </td>
      <td className="muted num">
        {runs.reduce((a, r) => a + r.spec.resources.gpus, 0) || <span className="faint">—</span>}
        {runs.some((r) => r.spec.resources.gpus) && <span className="faint"> GPU total</span>}
      </td>
      <td>{newest && <AgentCell run={newest} />}</td>
      <td>{newest && <CodeCell run={newest} />}</td>
      <td className="muted">{ago(newest?.createdAt, props.now)}</td>
      <td className="r num muted">
        <Link
          href={`/compare?group=${encodeURIComponent(props.name)}`}
          className="btn sm"
          title="Compare this group"
          onClick={(e) => {
            e.stopPropagation();
            onLinkClick(e);
          }}
          style={{ marginRight: 8 }}
        >
          <IconCompare size={12} />
          <span className="compare-label"> Compare</span>
        </Link>
        {duration(span)}
      </td>
    </tr>
  );
}
