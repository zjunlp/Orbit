// C3 / C4 trial view (design §9.15): the verifier's conversation, read turn by turn. Left: turns
// with their check status; middle: messages and tool-call cards; right: the selected turn's check,
// state diff, reference calls and raw record. The checker's first failure is one key away (`e`).
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { IconAlert, IconBan, IconCheck, IconSearch, IconX } from "../../components/icons.tsx";
import { Empty, Loading } from "../../components/ui.tsx";
import { api, fileUrl, type ReviewFile, type Run } from "../../lib/api.ts";
import {
  brief,
  type Conversation,
  callSummary,
  deepParse,
  diffStates,
  matches,
  parseConversation,
  parseResult,
  type ToolCall,
  type Turn,
  turnStats,
} from "../../lib/conversation.ts";
import { bytes } from "../../lib/format.ts";
import { overlayOpen, useHotkeys } from "../../lib/hotkeys.ts";
import { setQuery, useLocation } from "../../lib/router.ts";
import { useAsync } from "../../lib/use.ts";
import "./conversation.css";

const MAX_BYTES = 16 * 1024 * 1024;

export function ConversationFile({ run, file }: { run: Run; file: ReviewFile }) {
  const a = useAsync(() => api.artifacts(run.id), [run.id, run.state]);
  const entry = a.data?.files.find((f) => f.path === file.path);
  const source = useAsync(async () => {
    if (!entry || entry.bytes > MAX_BYTES) return null;
    const r = await fetch(fileUrl(run.id, file.path));
    if (!r.ok) throw new Error(`Could not read the conversation (${r.status}).`);
    return parseConversation(await r.text());
  }, [run.id, file.path, entry?.bytes, entry?.mtime]);
  const problem =
    a.error ??
    (a.data && !entry ? "The verifier did not save the declared conversation file." : null) ??
    (entry && entry.bytes > MAX_BYTES
      ? `${bytes(entry.bytes)} exceeds the preview limit; download ${file.path} from Outputs.`
      : null) ??
    source.error;
  if (problem) return <Empty title="Conversation unavailable">{problem}</Empty>;
  if (!source.data) return <Loading what="Loading the conversation" />;
  return <ConversationViewer c={source.data} />;
}

const STATUS_ICON = {
  passed: <IconCheck size={12} />,
  failed: <IconX size={12} />,
  unchecked: <IconBan size={12} />,
};

export function ConversationViewer({ c }: { c: Conversation }) {
  const loc = useLocation();
  const [q, setQ] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const failed = c.verdict.failedTurn ?? null;
  const fromUrl = loc.query.has("turn") ? Number(loc.query.get("turn")) : Number.NaN;
  const selected = c.turns.some((t) => t.index === fromUrl)
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
    setQuery({ turn: String(index) }, { replace: true });
    if (scroll)
      document
        .getElementById(`turn-${index}`)
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const step = (d: number) => {
    const i = c.turns.findIndex((t) => t.index === selected);
    const next = c.turns[Math.min(c.turns.length - 1, Math.max(0, i + d))];
    if (next) select(next.index);
  };
  useHotkeys({
    h: () => !overlayOpen() && step(-1),
    l: () => !overlayOpen() && step(1),
    e: () => !overlayOpen() && failed !== null && select(failed),
    "/": () => search.current?.focus(),
  });
  // Land on the failing turn when the page opens on it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per conversation
  useEffect(() => {
    if (loc.query.get("turn") === null && failed !== null)
      document.getElementById(`turn-${failed}`)?.scrollIntoView({ block: "start" });
  }, [c]);
  const shown = c.turns.map((t) => ({ t, events: t.events.filter((e) => matches(e, q)) }));
  const hits = q ? shown.reduce((n, x) => n + x.events.length, 0) : null;

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
          <ol>
            {c.turns.map((t) => {
              const s = turnStats(t);
              const status = t.check?.status;
              return (
                <li key={t.index}>
                  <button
                    type="button"
                    className={`conv-turn-link${t.index === selected ? " on" : ""} st-${status ?? "none"}`}
                    onClick={() => select(t.index)}
                  >
                    <span className="conv-turn-n">
                      {status && STATUS_ICON[status]} Turn {t.index + 1}
                    </span>
                    <span className="conv-turn-meta">
                      {s.calls} call{s.calls === 1 ? "" : "s"}
                      {s.errors > 0 && <span className="bad"> · {s.errors} error</span>}
                      {s.rejected > 0 && <span className="warn"> · {s.rejected} rejected</span>}
                    </span>
                    <span className="conv-turn-preview">{brief(s.preview, 70)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="conv-keys faint">
            <kbd>h</kbd>/<kbd>l</kbd> turns · <kbd>e</kbd> failure · <kbd>/</kbd> search
          </div>
        </aside>
        <main className="conv-main">
          <div className="conv-source faint">
            Tool results and states come from the verifier's independent replay of the recorded
            calls; replies are the agent's own text. The Agent session tab has what the agent saw.
          </div>
          {shown.map(({ t, events }) => (
            <section
              key={t.index}
              id={`turn-${t.index}`}
              className={`conv-turn${t.index === selected ? " on" : ""} st-${t.check?.status ?? "none"}`}
              onClick={() => t.index !== selected && select(t.index, false)}
              onKeyDown={undefined}
            >
              <header>
                <b>{whole ? "Conversation" : `Turn ${t.index + 1}`}</b>
                {!whole && <span className="faint mono">index {t.index}</span>}
                {t.check && (
                  <span className={`conv-check st-${t.check.status}`}>
                    {STATUS_ICON[t.check.status]} {t.check.status}
                  </span>
                )}
                {t.check?.status === "unchecked" && failed !== null && (
                  <span className="faint">
                    not checked: the checker stopped at turn {failed + 1}
                  </span>
                )}
                {t.note && <span className="conv-note">{t.note}</span>}
              </header>
              {t.check?.status === "failed" && t.check.detail && (
                <div className="conv-fail">
                  <IconAlert size={13} /> {t.check.detail}
                </div>
              )}
              {events.length === 0 && (
                <div className="faint conv-none">
                  {q
                    ? "No matching events in this turn."
                    : t.events.length === 0 && whole
                      ? "No messages or tool calls: this is the expected behavior of the do-nothing baseline."
                      : "No events in this turn."}
                </div>
              )}
              {events.map((e, i) =>
                e.type === "message" ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: messages have no id; order is fixed
                  <Message key={`m${i}`} actor={e.actor} text={e.text} label={label} />
                ) : (
                  <CallCard
                    key={e.id}
                    call={e}
                    label={label}
                    open0={t.check?.status === "failed"}
                    onOpen={() => t.index !== selected && select(t.index, false)}
                  />
                ),
              )}
            </section>
          ))}
          {c.turns.length === 0 && <Empty title="The conversation has no turns" />}
        </main>
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

type Labels = Record<string, Conversation["participants"][number]>;

function Message({ actor, text, label }: { actor: string; text: string; label: Labels }) {
  const role = label[actor]?.role ?? actor;
  return (
    <div className={`conv-msg role-${role}`}>
      <div className="conv-who">{label[actor]?.label ?? actor}</div>
      <div className="conv-text">{text || <span className="faint">(empty)</span>}</div>
    </div>
  );
}

function CallCard({
  call,
  label,
  open0 = false,
  onOpen,
}: {
  call: ToolCall;
  label: Labels;
  /** Open from the start (calls of the failing turn). */
  open0?: boolean;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(open0 || call.status !== "ok");
  const role = label[call.actor]?.role ?? call.actor;
  const result = parseResult(call.result);
  return (
    <div className={`conv-call st-${call.status} role-${role}`}>
      <button
        type="button"
        className="conv-call-h"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          if (!open) onOpen?.();
          setOpen(!open);
        }}
      >
        <span className={`conv-actor role-${role}`}>{label[call.actor]?.label ?? call.actor}</span>
        <span className="conv-caret" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span className="mono conv-call-sig">{callSummary(call)}</span>
        <span className="spacer" />
        {call.status !== "ok" && (
          <span className={`chip ${call.status === "error" ? "bad" : "warn"}`}>{call.status}</span>
        )}
        {call.status === "ok" && call.result !== undefined && (
          <span className="faint mono conv-call-res">→ {brief(call.result, 48)}</span>
        )}
      </button>
      {open && (
        <div className="conv-call-b">
          {call.source && call.source !== callSummary(call, 1e9) && (
            <Field label="As written">
              <pre className="mono">{call.source}</pre>
            </Field>
          )}
          <Field label="Arguments">
            <Json v={call.arguments} />
          </Field>
          {call.error && (
            <Field label={call.status === "rejected" ? "Rejected" : "Error"}>
              <pre className="mono conv-err">{call.error}</pre>
            </Field>
          )}
          {call.result !== undefined && call.status !== "error" && (
            <Field label="Result">
              <Json v={result} />
            </Field>
          )}
          <div className="faint mono">call {call.id}</div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="conv-field">
      <div className="conv-field-l">{label}</div>
      {children}
    </div>
  );
}

function Json({ v }: { v: unknown }) {
  const text = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return <pre className="mono conv-json">{text}</pre>;
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
