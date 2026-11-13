import { useEffect, useMemo, useRef, useState } from "react";
import {
  IconBot,
  IconBrain,
  IconChevron,
  IconChevronDown,
  IconTerminal,
  IconUser,
  IconWrench,
} from "../../components/icons.tsx";
import { CopyButton, Empty, Link, Loading, StateIcon } from "../../components/ui.tsx";
import { api, type Run, type SessionMessage, type SessionTranscript } from "../../lib/api.ts";
import { ago, dateTime, harnessLabel, runPath, runTitle } from "../../lib/format.ts";
import { useHotkeys } from "../../lib/hotkeys.ts";
import { useRuns, useRunsState } from "../../lib/runs-store.ts";
import { useAsync } from "../../lib/use.ts";

const RUN_ID = /\b\d{8}-\d{6}-[a-z0-9]{4}\b/g;
const ORBIT_CMD = /\borbit\s+(run|sweep|wait|cancel|note|logs|show|ps)\b/;

interface Turn {
  index: number;
  start: number;
  title: string;
  tools: number;
  orbit: boolean;
}

export function SessionTab({ run }: { run: Run }) {
  const s = useAsync(() => api.session(run.id), [run.id]);
  if (s.error)
    return (
      <Empty title="Sessions unavailable" icon={<IconBot size={30} />}>
        <p>{s.error}</p>
      </Empty>
    );
  if (!s.data) return <Loading what="Loading session" />;
  const { submitter, submitterError, agent, agentError } = s.data;
  if (agentError && !agent)
    return (
      <>
        <Empty title="Agent trajectory unavailable" icon={<IconBot size={30} />}>
          <p>{agentError}</p>
        </Empty>
        {submitter && <SessionView run={run} t={submitter} kind="submitter" />}
      </>
    );
  if (submitter && agent)
    return (
      <div className="session-split">
        <SessionView run={run} t={submitter} kind="submitter" pane />
        <SessionView run={run} t={agent} kind="agent" pane />
      </div>
    );
  if (agent) return <SessionView run={run} t={agent} kind="agent" />;
  if (submitter) return <SessionView run={run} t={submitter} kind="submitter" />;
  if (run.spec.agent)
    return (
      <Empty title="Session transcript unavailable" icon={<IconBot size={30} />}>
        <p>
          {harnessLabel(run.spec.agent.harness)} session{" "}
          <code>{run.spec.agent.sessionId ?? "(unknown id)"}</code>
        </p>
        <p>{submitterError}</p>
      </Empty>
    );
  return (
    <Empty title="No agent session" icon={<IconBot size={30} />}>
      <p>
        Runs submitted from Claude Code or Codex are linked to that session, and runs with an auth
        profile show the session of the Agent inside the container.
      </p>
      <p>
        Otherwise set <code>ORBIT_AGENT=codex:&lt;session-id&gt;</code> or{" "}
        <code>claude-code:&lt;id&gt;</code> when calling <code>orbit run</code>.
      </p>
    </Empty>
  );
}

const ROLE_LABEL = {
  submitter: "Submitted by",
  agent: "Agent in this run",
} as const;

/**
 * One transcript. `submitter` is the host session that submitted the run (marks where), `agent`
 * the session of the Agent inside the run. As a `pane` (two side by side) it drops the outline and
 * side panel.
 */
function SessionView(props: {
  run: Run;
  t: SessionTranscript;
  kind: "submitter" | "agent";
  pane?: boolean;
}) {
  const { run, t, kind, pane } = props;
  const allRuns = useRuns();
  const [showThinking, setShowThinking] = useState(false);
  const [expandAll, setExpandAll] = useState(false);
  const [onlyOrbit, setOnlyOrbit] = useState(false);
  const [focus, setFocus] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const messages = t.messages;
  const anchor = (i: number) => `${kind}-m-${i}`;

  const turns = useMemo(() => {
    const out: Turn[] = [];
    messages.forEach((m, i) => {
      if (m.role === "user" && m.kind === "text")
        out.push({
          index: out.length + 1,
          start: i,
          title: m.text.split("\n")[0]?.slice(0, 140) ?? "",
          tools: 0,
          orbit: false,
        });
      const cur = out[out.length - 1];
      if (!cur) return;
      if (m.kind === "tool_call") cur.tools++;
      if (m.kind === "tool_call" && ORBIT_CMD.test(m.text)) cur.orbit = true;
    });
    return out;
  }, [messages]);

  // Where this run was submitted: first tool output mentioning its id, else last message before createdAt.
  const here = useMemo(() => {
    if (kind !== "submitter") return -1;
    const byId = messages.findIndex((m) => m.kind === "tool_result" && m.text.includes(run.id));
    if (byId >= 0) return byId > 0 && messages[byId - 1]?.kind === "tool_call" ? byId - 1 : byId;
    const at = Date.parse(run.createdAt);
    let best = -1;
    messages.forEach((m, i) => {
      if (m.at && Date.parse(m.at) <= at) best = i;
    });
    return best;
  }, [messages, run.id, run.createdAt, kind]);

  const sessionRuns = useMemo(
    () =>
      allRuns.filter(
        (r) => r.spec.agent?.sessionId && r.spec.agent.sessionId === run.spec.agent?.sessionId,
      ),
    [allRuns, run.spec.agent?.sessionId],
  );

  const scrollTo = (i: number) => {
    setFocus(i);
    document.getElementById(anchor(i))?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: anchor only depends on kind
  useEffect(() => {
    if (here < 0 || !messages.length) return;
    const tm = setTimeout(
      () => document.getElementById(anchor(here))?.scrollIntoView({ block: "center" }),
      50,
    );
    return () => clearTimeout(tm);
  }, [here, messages.length]);

  const curTurn = focus === null ? -1 : turns.findLastIndex((x) => x.start <= focus);
  // Prompt navigation only when one session fills the tab.
  useHotkeys({
    l: () => {
      const x = turns[Math.min(curTurn + 1, turns.length - 1)];
      if (x && !pane) scrollTo(x.start);
    },
    h: () => {
      const x = turns[Math.max(curTurn - 1, 0)];
      if (x && !pane) scrollTo(x.start);
    },
  });

  const visible = (m: SessionMessage) => (m.kind === "thinking" ? showThinking : true);
  const turnOf = (i: number) => turns.findLastIndex((x) => x.start <= i);
  const orbitTurns = new Set(turns.filter((x) => x.orbit).map((x) => x.index - 1));

  const transcript = (
    <div ref={box} className="transcript">
      {t.completeness === "truncated" && (
        <p className="muted">
          This session is incomplete. Some records or usage could not be recovered.
        </p>
      )}
      <div className="toolbar session-toolbar">
        <IconBot size={14} />
        <span className="faint">{ROLE_LABEL[kind]}</span>
        <b>{harnessLabel(t.harness)}</b>
        <span className="mono faint ellipsis" style={{ minWidth: 0 }}>
          {t.sessionId}
        </span>
        <CopyButton text={t.sessionId} title="Copy session id" />
        {!pane && <span className="faint">{messages.length} messages</span>}
        <div className="spacer" />
        {here >= 0 && (
          <button type="button" className="btn sm" onClick={() => scrollTo(here)}>
            <span className="dot" style={{ "--c": "var(--st-running)" } as React.CSSProperties} />{" "}
            {pane ? "Submitted here" : "Where this run was submitted"}
          </button>
        )}
        <button
          type="button"
          className={`btn sm${showThinking ? " on" : ""}`}
          onClick={() => setShowThinking(!showThinking)}
        >
          <IconBrain size={12} /> Thinking
        </button>
        <button
          type="button"
          className={`btn sm${expandAll ? " on" : ""}`}
          onClick={() => setExpandAll(!expandAll)}
        >
          Expand tools
        </button>
      </div>
      {messages.length === 0 && <Empty title="Empty transcript" />}
      {messages.map((m, i) =>
        !visible(m) || (onlyOrbit && !orbitTurns.has(turnOf(i))) ? null : (
          <Message
            key={String(i)}
            id={anchor(i)}
            m={m}
            here={i === here}
            focus={i === focus}
            turn={m.role === "user" && m.kind === "text"}
            expandAll={expandAll}
          />
        ),
      )}
    </div>
  );
  if (pane) return <div className="session-pane">{transcript}</div>;

  return (
    <div className={kind === "submitter" ? "session" : "session no-aside"}>
      <div className="outline">
        <div className="row" style={{ padding: "2px 8px 8px", gap: 6 }}>
          <span className="faint" style={{ fontSize: 12 }}>
            {turns.length} prompts
          </span>
          <div className="spacer" />
          <button
            type="button"
            className={`btn sm${onlyOrbit ? " on" : ""}`}
            onClick={() => setOnlyOrbit(!onlyOrbit)}
            title="Only prompts where the agent used orbit"
          >
            <IconTerminal size={12} /> orbit
          </button>
        </div>
        {turns
          .filter((x) => !onlyOrbit || x.orbit)
          .map((x) => {
            const containsHere =
              here >= x.start && (turns[x.index]?.start ?? Number.POSITIVE_INFINITY) > here;
            return (
              <div
                key={x.index}
                className={`o${curTurn === x.index - 1 ? " on" : ""}`}
                onClick={() => scrollTo(x.start)}
              >
                <span className="i">{x.index}</span>
                <div className="grow">
                  <div className="t">{x.title || <span className="faint">(empty)</span>}</div>
                  <div className="row faint" style={{ gap: 8, fontSize: 11, marginTop: 2 }}>
                    {x.tools > 0 && (
                      <span className="row" style={{ gap: 3 }}>
                        <IconWrench size={10} /> {x.tools}
                      </span>
                    )}
                    {x.orbit && <span style={{ color: "var(--accent)" }}>orbit</span>}
                    {containsHere && <span style={{ color: "var(--st-running)" }}>● this run</span>}
                  </div>
                </div>
              </div>
            );
          })}
      </div>
      {transcript}
      {kind === "submitter" && (
        <aside className="aside">
          <section className="card">
            <div className="card-h">Session</div>
            <div className="card-b">
              <dl className="kv" style={{ fontSize: 12 }}>
                <dt>Messages</dt>
                <dd>{messages.length}</dd>
                <dt>Started</dt>
                <dd>{dateTime(messages.find((m) => m.at)?.at)}</dd>
                <dt>Last</dt>
                <dd>{ago(messages.findLast((m) => m.at)?.at)}</dd>
                {run.spec.agent?.cwd && (
                  <>
                    <dt>cwd</dt>
                    <dd className="mono" style={{ fontSize: 11 }}>
                      {run.spec.agent.cwd}
                    </dd>
                  </>
                )}
              </dl>
            </div>
          </section>
          <section className="card" style={{ marginTop: 12 }}>
            <div className="card-h">
              Runs from this session <span className="sub">{sessionRuns.length}</span>
            </div>
            <div style={{ padding: 6 }}>
              {sessionRuns.map((r) => (
                <Link
                  key={r.id}
                  href={`${runPath(r.id)}?tab=session`}
                  className="row"
                  style={{
                    padding: "5px 8px",
                    borderRadius: 6,
                    color: "var(--text)",
                    background: r.id === run.id ? "var(--selected)" : undefined,
                  }}
                >
                  <StateIcon state={r.state} size={12} />
                  <span className="grow ellipsis">{runTitle(r)}</span>
                  <span className="faint" style={{ fontSize: 11 }}>
                    {ago(r.createdAt)}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        </aside>
      )}
    </div>
  );
}

function RunRefs({ text }: { text: string }) {
  const { runs } = useRunsState();
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(RUN_ID)) {
    const i = m.index ?? 0;
    const r = runs.get(m[0]);
    if (!r) continue;
    parts.push(text.slice(last, i));
    parts.push(
      <Link key={i} href={`${runPath(r.id)}`} className="runref" title={runTitle(r)}>
        <StateIcon state={r.state} size={11} />
        {m[0]}
      </Link>,
    );
    last = i + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

/** Show shell tool calls as the command itself instead of their JSON input. */
function toolText(m: SessionMessage): string {
  if (m.kind !== "tool_call" || !m.text.startsWith("{")) return m.text;
  try {
    const input = JSON.parse(m.text) as Record<string, unknown>;
    const cmd = input.command ?? input.cmd;
    const line = Array.isArray(cmd) ? cmd.join(" ") : cmd;
    if (typeof line !== "string") return m.text;
    const desc = typeof input.description === "string" ? `# ${input.description}\n` : "";
    return `${desc}$ ${line}`;
  } catch {
    return m.text;
  }
}

function clip(text: string, lines: number): [string, boolean] {
  const ls = text.split("\n");
  if (ls.length <= lines && text.length < 1500) return [text, false];
  return [ls.slice(0, lines).join("\n").slice(0, 1500), true];
}

function Message(props: {
  id: string;
  m: SessionMessage;
  here: boolean;
  focus: boolean;
  turn: boolean;
  expandAll: boolean;
}) {
  const { m } = props;
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? props.expandAll;
  const cls = `msg ${m.role}${props.turn ? " turn" : ""}${props.here ? " here" : ""}${props.focus ? " focus" : ""}`;
  const time = m.at ? new Date(m.at).toLocaleTimeString(undefined, { hour12: false }) : "";

  if (m.kind === "tool_call" || m.kind === "tool_result") {
    const result = m.kind === "tool_result";
    const text = toolText(m);
    const [short, more] = clip(text, result ? 6 : 14);
    const orbit = !result && ORBIT_CMD.test(m.text);
    return (
      <div id={props.id} className={cls}>
        {props.here && <div className="here-label">● this run was submitted here</div>}
        <div
          className={`tool${result ? " result" : ""}`}
          style={orbit ? { borderColor: "var(--accent)" } : undefined}
        >
          <header onClick={() => setOpen(!expanded)}>
            {expanded || !more ? <IconChevronDown size={12} /> : <IconChevron size={12} />}
            {result ? <IconTerminal size={12} /> : <IconWrench size={12} />}
            <span className="name">{m.name ?? "tool"}</span>
            <span className="faint">{result ? "result" : "call"}</span>
            {orbit && (
              <span className="chip" style={{ height: 18, color: "var(--accent)" }}>
                orbit
              </span>
            )}
            {m.truncated && (
              <span className="chip warn" style={{ height: 18 }}>
                clipped
              </span>
            )}
            <div className="spacer" />
            <span className="faint mono" style={{ fontSize: 11 }}>
              {time}
            </span>
          </header>
          {(text || !result) && (
            <pre>
              <RunRefs text={expanded ? text : short} />
              {more && !expanded && (
                <span className="faint" style={{ cursor: "pointer" }} onClick={() => setOpen(true)}>
                  {"\n"}… show all ({text.split("\n").length} lines)
                </span>
              )}
            </pre>
          )}
        </div>
      </div>
    );
  }
  if (m.kind === "thinking")
    return (
      <div id={props.id} className={cls}>
        <div className="thinking" onClick={() => setOpen(!expanded)}>
          <IconBrain size={12} />{" "}
          {expanded ? m.text : `${m.text.slice(0, 160)}${m.text.length > 160 ? "…" : ""}`}
        </div>
      </div>
    );
  return (
    <div id={props.id} className={cls}>
      <div className="who">
        {m.role === "user" ? <IconUser size={13} /> : <IconBot size={13} />}
        <b>{m.role === "user" ? "User" : m.role === "assistant" ? "Agent" : m.role}</b>
        <span className="mono">{time}</span>
      </div>
      {props.here && <div className="here-label">● this run was submitted here</div>}
      <div className="body">
        <RunRefs text={m.text} />
      </div>
    </div>
  );
}
