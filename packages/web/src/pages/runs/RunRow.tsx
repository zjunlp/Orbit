import { IconBot, IconFolder, IconGit } from "../../components/icons.tsx";
import { Link, Params, StateBadge } from "../../components/ui.tsx";
import type { Run } from "../../lib/api.ts";
import {
  ago,
  dateTime,
  duration,
  harnessLabel,
  runDuration,
  runPath,
  runTitle,
} from "../../lib/format.ts";
import { navigate, onLinkClick } from "../../lib/router.ts";

function Resources({ run }: { run: Run }) {
  const r = run.spec.resources;
  return (
    <span className="muted num">
      {r.gpus ? (
        <b style={{ color: "var(--text)", fontWeight: 500 }}>{r.gpus}× GPU</b>
      ) : (
        <span className="faint">CPU</span>
      )}
      <span className="faint">
        {" "}
        · {r.cpus}c · {r.memGB}G
      </span>
    </span>
  );
}

export function AgentCell({ run }: { run: Run }) {
  const a = run.spec.agent;
  if (!a) return <span className="faint">—</span>;
  return (
    <span className="row muted" style={{ gap: 5 }} title={a.sessionId ?? "session not identified"}>
      <IconBot size={13} />
      {harnessLabel(a.harness)}
    </span>
  );
}

export function CodeCell({ run }: { run: Run }) {
  const c = run.code;
  if (!c) return <span className="faint">—</span>;
  return (
    <span
      className="row mono muted"
      style={{ gap: 5 }}
      title={`${c.branch ?? "detached"} @ ${c.commit ?? "no commit"}`}
    >
      <IconGit size={13} />
      {c.commit?.slice(0, 7) ?? "none"}
      {c.dirty && (
        <span
          className="chip warn mono"
          style={{ height: 18, padding: "0 6px" }}
          title={c.changedFiles.join("\n")}
        >
          +{c.changedFiles.length}
        </span>
      )}
    </span>
  );
}

export function RunRow(props: {
  run: Run;
  inGroup: boolean;
  cursor: boolean;
  selected: boolean;
  onSelect: () => void;
  onHover: () => void;
  now: number;
}) {
  const { run, inGroup } = props;
  const cls = ["click", props.cursor && "cursor", props.selected && "sel"]
    .filter(Boolean)
    .join(" ");
  return (
    <tr className={cls} onClick={() => navigate(runPath(run.id))} onMouseMove={props.onHover}>
      <td onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          className="check"
          checked={props.selected}
          onChange={props.onSelect}
        />
      </td>
      <td>
        <StateBadge state={run.state} />
      </td>
      <td>
        <div className="row" style={{ gap: 8, paddingLeft: inGroup ? 18 : 0 }}>
          <Link
            href={runPath(run.id)}
            className="ellipsis"
            style={{ color: "var(--text)", fontWeight: 500 }}
            title={runTitle(run)}
            onClick={(e) => {
              e.stopPropagation();
              onLinkClick(e);
            }}
          >
            {runTitle(run)}
          </Link>
          <span className="faint mono ellipsis" style={{ fontSize: 11 }}>
            {run.id}
          </span>
          {run.cleanup === "failed" && <span className="chip bad">cleanup failed</span>}
          {run.folder && (
            <span className="chip mono faint" title={`folder ${run.folder}`}>
              <IconFolder size={11} /> {run.folder}
            </span>
          )}
          {run.note && (
            <span className="chip" title={run.note}>
              note
            </span>
          )}
        </div>
        {run.state === "queued" && run.reason && (
          <div
            className="faint"
            style={{
              fontSize: 11.5,
              paddingLeft: inGroup ? 18 : 0,
              lineHeight: 1.2,
              marginTop: -4,
              marginBottom: 4,
            }}
          >
            {run.reason}
          </div>
        )}
      </td>
      <td>
        <Params params={run.spec.params} />
      </td>
      <td>
        <Resources run={run} />
      </td>
      <td>
        <AgentCell run={run} />
      </td>
      <td>
        <CodeCell run={run} />
      </td>
      <td className="muted" title={dateTime(run.createdAt)}>
        {ago(run.createdAt, props.now)}
      </td>
      <td className="r num muted">{duration(runDuration(run, props.now))}</td>
    </tr>
  );
}
