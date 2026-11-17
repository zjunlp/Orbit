// C3 / C4 trial view (design §9.15): the verifier's conversation, read turn by turn. Left: turns
// with their check status; middle: messages and tool-call cards; right: the selected turn's check,
// state diff, reference calls and raw record. The checker's first failure is one key away (`e`).

import type { SessionMessage } from "@zjunlp/orbit/contracts";
import { Fragment, useMemo, useRef, useState } from "react";
import { IconCheck, IconSearch, IconX } from "../../components/icons.tsx";
import { Empty, Loading } from "../../components/ui.tsx";
import { api, type ReviewFile, type Run } from "../../lib/api.ts";
import type { ReplayControl } from "../../lib/atif.ts";
import {
  brief,
  type Conversation,
  callSummary,
  deepParse,
  diffStates,
  parseConversation,
  type ToolCall,
  type Turn,
} from "../../lib/conversation.ts";
import { bytes } from "../../lib/format.ts";
import { overlayOpen, useHotkeys } from "../../lib/hotkeys.ts";
import { setQuery, useLocation } from "../../lib/router.ts";
import { useRunFile } from "../../lib/run-file.ts";
import { useAsync } from "../../lib/use.ts";
import { ConversationMessages, ConversationTurns } from "./ConversationList.tsx";
import { conversationRows, indexConversation } from "./conversation-model.ts";
import { Field, Json, STATUS_ICON } from "./conversation-parts.tsx";
import "./conversation.css";

const MAX_BYTES = 16 * 1024 * 1024;

export function ConversationFile({
  run,
  file,
  solve,
}: {
  run: Run;
  file: ReviewFile;
  solve?: Run;
}) {
  const sessionRun = solve ?? run;
  const session = useAsync(
    (signal) => api.session(sessionRun.id, signal),
    [sessionRun.id, sessionRun.state],
    { resetKey: sessionRun.id },
  );
  const source = useRunFile(run, file.path, {
    what: "the conversation",
    maxBytes: MAX_BYTES,
    parse: parseConversation,
    load: (signal) => api.environment(run.id, file.path, "conversation", sessionRun.id, signal),
    loadKey: sessionRun.id,
  });
  const problem =
    (source.missing ? "The verifier did not save the declared conversation file." : null) ??
    (source.tooLarge && source.entry
      ? `${bytes(source.entry.bytes)} exceeds the preview limit; download ${file.path} from Outputs.`
      : null) ??
    source.error;
  return (
    <div className="conv-file">
      <div className="toolbar">
        <span className="faint">Saved conversation</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn sm"
          aria-label="Refresh conversation"
          onClick={() => {
            source.reload();
            session.reload();
          }}
        >
          Refresh
        </button>
      </div>
      {problem ? (
        <Empty title="Conversation unavailable">{problem}</Empty>
      ) : !source.data ? (
        <Loading what="Loading the conversation" />
      ) : (
        <ConversationViewer
          key={`${run.id}/${file.path}/${sessionRun.id}`}
          c={source.data}
          messages={session.data?.agent?.messages ?? []}
        />
      )}
    </div>
  );
}

export function ConversationViewer({
  c,
  messages = [],
  control,
}: {
  c: Conversation;
  messages?: SessionMessage[];
  control?: ReplayControl;
}) {
  const loc = useLocation();
  const [q, setQ] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const indexed = useMemo(() => indexConversation(c), [c]);
  const followSelection = useRef(true);
  const [jump, setJump] = useState(0);
  const failed = c.verdict.failedTurn ?? null;
  const fromUrl = loc.query.has("turn") ? Number(loc.query.get("turn")) : Number.NaN;
  const selected = control
    ? (c.turns[control.index]?.index ?? 0)
    : c.turns.some((t) => t.index === fromUrl)
      ? fromUrl
      : (failed ?? c.turns[0]?.index ?? 0);
  const turn = c.turns.find((t) => t.index === selected);
  const label = useMemo(
    () =>
      Object.fromEntries(
        c.participants.map((p) => [p.id, { ...p, label: participantLabel(p) }] as const),
      ),
    [c.participants],
  );
  const [wide, setWide] = useState(false);
  /** One unchecked turn: the benchmark judges the whole conversation (τ²), not turns. */
  const whole = c.turns.length <= 1 && !c.turns.some((t) => t.check);
  const select = (index: number, scroll = true) => {
    followSelection.current = scroll;
    if (scroll) setJump((value) => value + 1);
    if (control) {
      control.select(c.turns.findIndex((t) => t.index === index));
      return;
    }
    setQuery({ turn: String(index) }, { replace: true });
  };
  const step = (d: number) => {
    const i = c.turns.findIndex((t) => t.index === selected);
    const next = c.turns[Math.min(c.turns.length - 1, Math.max(0, i + d))];
    if (next) select(next.index);
  };
  useHotkeys(
    control
      ? {}
      : {
          h: () => !overlayOpen() && step(-1),
          l: () => !overlayOpen() && step(1),
          e: () => !overlayOpen() && failed !== null && select(failed),
          "/": () => search.current?.focus(),
        },
  );
  const onlyTurn = control ? selected : undefined;
  const layout = useMemo(() => conversationRows(indexed, q, onlyTurn), [indexed, q, onlyTurn]);
  const hits = q ? layout.hits : null;

  return (
    <div className="conv">
      <Verdict c={c} onJump={failed !== null ? () => select(failed) : undefined} />
      <div className={`conv-body${wide ? " wide" : ""}`}>
        <aside className="conv-rail" aria-label="Turns">
          <div className="conv-search">
            <IconSearch size={13} />
            <input
              ref={search}
              className="input"
              type="search"
              placeholder="Search messages, calls, results  /"
              aria-label="Search the conversation"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                setQ("");
                e.currentTarget.blur();
              }}
            />
          </div>
          {hits !== null && <div className="faint conv-hits">{hits} matching events</div>}
          <ConversationTurns indexed={indexed} selected={selected} onSelect={select} />
          <div className="conv-keys faint">
            <kbd>h</kbd>/<kbd>l</kbd> turns · <kbd>e</kbd> failure · <kbd>/</kbd> search
          </div>
        </aside>
        <ConversationMessages
          indexed={indexed}
          query={q}
          selected={selected}
          layout={layout}
          jump={jump}
          whole={whole}
          failed={failed}
          label={label}
          messages={messages}
          followSelection={followSelection}
          onSelect={select}
        />
        <aside className="conv-inspector" aria-label="Selected turn">
          {turn ? (
            <Inspector
              key={turn.index}
              c={c}
              turn={turn}
              whole={whole}
              wide={wide}
              toggleWide={() => setWide(!wide)}
            />
          ) : (
            <Empty title="No turn" />
          )}
        </aside>
      </div>
    </div>
  );
}

function Verdict({ c, onJump }: { c: Conversation; onJump?: () => void }) {
  const v = c.verdict;
  const failed = v.checks.filter((x) => x.status === "failed").length;
  return (
    <div className={`conv-verdict ${v.passed ? "ok" : v.passed === false ? "bad" : ""}`}>
      <div className="conv-verdict-main">
        <span className="conv-verdict-title">
          {v.passed ? <IconCheck size={15} /> : <IconX size={15} />}
          {v.passed
            ? "Task passed the benchmark's checker"
            : v.passed === false
              ? "Task failed the benchmark's checker"
              : "No verdict"}
        </span>
        {v.type && <span className="chip mono">{v.type}</span>}
        {v.failedTurn != null && (
          <button type="button" className="btn sm" onClick={onJump}>
            First detected at turn {v.failedTurn + 1}
            <span className="faint">(index {v.failedTurn})</span> <kbd>e</kbd>
          </button>
        )}
        {v.passed === false && v.failedTurn == null && (
          <span className="faint">The checker does not name a turn</span>
        )}
        <span className="spacer" />
        {c.completeness && c.completeness !== "complete" && (
          <span className="chip warn" title="What this record covers">
            {c.completeness}
          </span>
        )}
        {c.trust && (
          <span className="chip" title={`Written by the ${c.producer ?? "unknown"}`}>
            {c.trust} · {c.producer ?? "?"}
          </span>
        )}
        {v.scorer && <span className="faint mono">{v.scorer}</span>}
      </div>
      {v.message && (
        <div className="conv-verdict-msg">
          {v.message}
          {v.failedTurn != null && /turn \d/.test(v.message) && (
            <span className="faint"> (the checker counts turns from 0)</span>
          )}
        </div>
      )}
      {v.explanation && <div className="conv-verdict-why">{v.explanation}</div>}
      {v.checks.length > 0 && (
        <div className="conv-checks">
          {v.checks
            .filter((x) => x.status === "failed" && x.scored !== false)
            .slice(0, 3)
            .map((x) => (
              <span key={x.name} className="conv-check st-failed" title={x.detail ?? x.name}>
                {STATUS_ICON.failed} {x.name}
              </span>
            ))}
          <span className="faint">
            {failed}/{v.checks.length} checks failed
            {v.checks.some((x) => x.scored === false) ? " (scored and diagnostic)" : ""} · details
            in the inspector
          </span>
        </div>
      )}
      <div className="conv-legend">
        {c.participants.map((p) => (
          <span key={p.id} className={`conv-actor role-${p.role}`}>
            {p.role} <b>{p.label}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

type InspectorTab = "check" | "state" | "reference" | "final" | "raw";

function Inspector({
  c,
  turn,
  whole,
  wide,
  toggleWide,
}: {
  c: Conversation;
  turn: Turn;
  whole: boolean;
  wide: boolean;
  toggleWide: () => void;
}) {
  const tabs: [InspectorTab, string][] = [
    ["check", "Check"],
    ...(turn.state ? [["state", "State"] as [InspectorTab, string]] : []),
    ...(turn.reference ? [["reference", "Reference vs actual"] as [InspectorTab, string]] : []),
    ...(c.finalState?.length ? [["final", "Final state"] as [InspectorTab, string]] : []),
    ["raw", "Raw"],
  ];
  // A failing turn opens on the evidence: the state diff when the state differs, else the check.
  const stateDiffers = useMemo(() => {
    const st = turn.state as { before: unknown; after: unknown; expected?: unknown } | undefined;
    return st ? diffStates(st.before, st.after, st.expected).some((r) => r.mismatch) : false;
  }, [turn.state]);
  const [tab, setTab] = useState<InspectorTab>(
    turn.check?.status === "failed" && stateDiffers ? "state" : "check",
  );
  const active = tabs.some(([k]) => k === tab) ? tab : "check";
  return (
    <div className="conv-insp">
      <div className="conv-insp-h">
        {whole ? "Whole conversation" : `Turn ${turn.index + 1}`}
        <span className="spacer" />
        <button type="button" className="btn sm ghost" onClick={toggleWide}>
          {wide ? "Narrow" : "Widen"}
        </button>
      </div>

      <nav className="tabs conv-tabs">
        {tabs.map(([k, l]) => (
          <a
            key={k}
            href={`#${k}`}
            className={active === k ? "on" : ""}
            onClick={(e) => {
              e.preventDefault();
              setTab(k);
            }}
          >
            {l}
          </a>
        ))}
      </nav>
      <div className="conv-insp-b">
        {active === "check" && <CheckTab c={c} turn={turn} />}
        {active === "state" && turn.state && <StateTab turn={turn} />}
        {active === "reference" && <ReferenceTab turn={turn} />}
        {active === "final" && <FinalTab c={c} />}
        {active === "raw" && <Json v={turn} />}
      </div>
    </div>
  );
}

function CheckTab({ c, turn }: { c: Conversation; turn: Turn }) {
  const s = turn.check?.status;
  const isFailure = c.verdict.failedTurn === turn.index;
  return (
    <div className="col" style={{ gap: 10 }}>
      {s ? (
        <div className={`conv-check big st-${s}`}>
          {STATUS_ICON[s]}{" "}
          {s === "passed"
            ? "This turn passed the checker"
            : s === "failed"
              ? "The checker first failed here"
              : "Not checked: the checker stopped at an earlier failure"}
        </div>
      ) : (
        <p className="muted">The benchmark checks the whole conversation, not each turn.</p>
      )}
      {turn.check?.detail && <p>{turn.check.detail}</p>}
      {isFailure && c.verdict.explanation && <p>{c.verdict.explanation}</p>}
      {isFailure && c.verdict.details !== undefined && (
        <Field label="Checker details">
          <Json v={deepParse(c.verdict.details)} />
        </Field>
      )}
      {!turn.check &&
        [true, false].map((scored) => {
          const list = c.verdict.checks.filter((x) => (x.scored ?? true) === scored);
          if (!list.length) return null;
          return (
            <div key={String(scored)}>
              <div className="conv-field-l">
                {scored ? "Scored checks" : "Diagnostic checks (do not change the score)"}
              </div>
              <ul className="conv-check-list">
                {list.map((x) => (
                  <li key={x.name} className={`st-${x.status}`}>
                    {STATUS_ICON[x.status]} {x.name}
                    {x.detail && <div className="faint">{x.detail}</div>}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      <p className="faint">
        Tool errors are behavior the agent may recover from; the checker decides task success.
      </p>
    </div>
  );
}

/** A state value cut to one line; click to see all of it. */
function Val({ v, has }: { v: unknown; has: boolean }) {
  const [full, setFull] = useState(false);
  if (!has) return <i>absent</i>;
  const text = typeof v === "string" ? v : JSON.stringify(v, null, full ? 2 : undefined);
  if (text.length <= 60) return <>{text}</>;
  return (
    <button type="button" className="conv-val" onClick={() => setFull(!full)} title="Show all">
      {full ? <pre>{text}</pre> : brief(v, 60)}
    </button>
  );
}

function StateTab({ turn }: { turn: Turn }) {
  const [onlyMismatch, setOnlyMismatch] = useState(false);
  const st = turn.state as { before: unknown; after: unknown; expected?: unknown };
  const rows = useMemo(() => diffStates(st.before, st.after, st.expected), [st]);
  const shown = onlyMismatch ? rows.filter((r) => r.mismatch) : rows;
  const hasExpected = st.expected !== undefined;
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 10 }}>
        <span className="faint">
          {rows.filter((r) => r.changed).length} changed
          {hasExpected && ` · ${rows.filter((r) => r.mismatch).length} differ from expected`}
        </span>
        <span className="spacer" />
        {hasExpected && (
          <label className="row faint" style={{ gap: 4 }}>
            <input
              type="checkbox"
              checked={onlyMismatch}
              onChange={(e) => setOnlyMismatch(e.target.checked)}
            />
            Only differences from expected
          </label>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="muted">
          {hasExpected ? "No change, and the state matches the expected state." : "No change."}
        </p>
      ) : (
        <table className="table conv-state">
          <thead>
            <tr>
              <th>Path</th>
              <th>Before</th>
              <th>After</th>
              {hasExpected && <th>Expected</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.path} className={r.mismatch ? "mismatch" : ""}>
                <td className="mono">{r.path}</td>
                <td className="mono">
                  <Val v={r.before} has={"before" in r} />
                </td>
                <td className={`mono${r.changed ? " changed" : ""}`}>
                  <Val v={r.after} has={"after" in r} />
                </td>
                {hasExpected && (
                  <td className="mono">
                    {"expected" in r ? brief(r.expected, 60) : <i>absent</i>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="faint">
        Public environment state after the turn, from the verifier's replay; expected is the
        reference solution's state.
      </p>
    </div>
  );
}

function ReferenceTab({ turn }: { turn: Turn }) {
  const actual = turn.events.filter((e): e is ToolCall => e.type === "tool_call");
  const ref = turn.reference ?? [];
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="conv-ref">
        <div>
          <div className="conv-field-l">Reference ({ref.length})</div>
          {ref.length ? (
            ref.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: reference calls are a fixed list
              <div key={`r${i}`} className="mono conv-ref-line">
                {r}
              </div>
            ))
          ) : (
            <div className="faint">No call expected</div>
          )}
        </div>
        <div>
          <div className="conv-field-l">Actual ({actual.length})</div>
          {actual.length ? (
            actual.map((a) => (
              <div key={a.id} className={`mono conv-ref-line st-${a.status}`}>
                {a.source ?? callSummary(a, 1e9)}
              </div>
            ))
          ) : (
            <div className="faint">No call made</div>
          )}
        </div>
      </div>
      <p className="faint">
        For diagnosis only: the checker compares states and responses, not call text or order.
      </p>
    </div>
  );
}

function FinalTab({ c }: { c: Conversation }) {
  const rows = c.finalState ?? [];
  const [onlyMismatch, setOnlyMismatch] = useState(true);
  const mismatch = (r: (typeof rows)[number]) =>
    JSON.stringify(r.expected) !== JSON.stringify(r.actual);
  const shown = onlyMismatch ? rows.filter(mismatch) : rows;
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 10 }}>
        <span className="faint">
          {rows.filter(mismatch).length} differ from expected ·{" "}
          {rows.filter((r) => JSON.stringify(r.actual) !== JSON.stringify(r.initial)).length}{" "}
          changed by the run · {rows.length} paths compared
        </span>
        <span className="spacer" />
        <label className="row faint" style={{ gap: 4 }}>
          <input
            type="checkbox"
            checked={onlyMismatch}
            onChange={(e) => setOnlyMismatch(e.target.checked)}
          />
          Only differences
        </label>
      </div>
      {shown.length === 0 ? (
        <p className="muted">The final state matches the expected state on every changed path.</p>
      ) : (
        <table className="table conv-state">
          <thead>
            <tr>
              <th>Path</th>
              <th>Initial</th>
              <th>Expected</th>
              <th>Actual</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <Fragment key={r.path}>
                <tr className={mismatch(r) ? "mismatch" : ""}>
                  <td className="mono">{r.path}</td>
                  <td className="mono">{"initial" in r ? brief(r.initial, 50) : <i>absent</i>}</td>
                  <td className="mono">
                    {"expected" in r ? brief(r.expected, 50) : <i>absent</i>}
                  </td>
                  <td className="mono changed">
                    {"actual" in r ? brief(r.actual, 50) : <i>absent</i>}
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      <p className="faint">
        The database after replaying the conversation's tool calls on a fresh environment, against
        the reference actions' result.
      </p>
    </div>
  );
}

/** Calibration baselines say what they are, so an empty conversation is not read as a failure. */
function participantLabel(p: Conversation["participants"][number]): string {
  if (p.role !== "agent") return p.label;
  if (p.label === "empty") return "empty · do-nothing baseline";
  if (p.label === "oracle") return "oracle · reference solution";
  return p.label;
}
