import { useVirtualizer } from "@tanstack/react-virtual";
import type { SessionMessage } from "@zjunlp/orbit/contracts";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconAlert } from "../../components/icons.tsx";
import { Empty } from "../../components/ui.tsx";
import { brief } from "../../lib/conversation.ts";
import { CallCard, type Labels, Message } from "./ConversationEvents.tsx";
import type { conversationRows, indexConversation } from "./conversation-model.ts";
import { STATUS_ICON } from "./conversation-parts.tsx";
import { SessionSteps } from "./SessionSteps.tsx";

type Indexed = ReturnType<typeof indexConversation>;

export function ConversationTurns({
  indexed,
  selected,
  onSelect,
}: {
  indexed: Indexed;
  selected: number;
  onSelect: (index: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: indexed.length,
    getScrollElement: () => box.current,
    getItemKey: (i) => indexed[i]?.turn.index ?? i,
    estimateSize: () => 94,
    overscan: 4,
    initialRect: { width: 230, height: 560 },
  });
  const position = indexed.findIndex(({ turn }) => turn.index === selected);
  useEffect(() => {
    if (position >= 0) virtual.scrollToIndex(position, { align: "auto" });
  }, [position, virtual]);
  return (
    <div className="conv-turns" ref={box}>
      <ol style={{ height: virtual.getTotalSize(), position: "relative" }}>
        {virtual.getVirtualItems().map((item) => {
          const row = indexed[item.index];
          if (!row) return null;
          const { turn, stats } = row;
          const status = turn.check?.status;
          return (
            <li
              key={item.key}
              data-index={item.index}
              ref={virtual.measureElement}
              style={{
                position: "absolute",
                width: "100%",
                top: 0,
                transform: `translateY(${item.start}px)`,
              }}
              aria-posinset={item.index + 1}
              aria-setsize={indexed.length}
            >
              <button
                type="button"
                className={`conv-turn-link${turn.index === selected ? " on" : ""} st-${status ?? "none"}`}
                aria-current={turn.index === selected ? "step" : undefined}
                onClick={() => onSelect(turn.index)}
              >
                <span className="conv-turn-n">
                  {status && STATUS_ICON[status]} Turn {turn.index + 1}
                </span>
                <span className="conv-turn-meta">
                  {stats.calls} call{stats.calls === 1 ? "" : "s"}
                  {stats.errors > 0 && <span className="bad"> · {stats.errors} error</span>}
                  {stats.rejected > 0 && <span className="warn"> · {stats.rejected} rejected</span>}
                </span>
                <span className="conv-turn-preview">{brief(stats.preview, 70)}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function ConversationMessages({
  indexed,
  query,
  selected,
  layout,
  jump,
  whole,
  failed,
  label,
  messages,
  followSelection,
  onSelect,
}: {
  indexed: Indexed;
  query: string;
  selected: number;
  layout: ReturnType<typeof conversationRows>;
  jump: number;
  whole: boolean;
  failed: number | null;
  label: Labels;
  messages: SessionMessage[];
  followSelection: RefObject<boolean>;
  onSelect: (index: number, scroll?: boolean) => void;
}) {
  const box = useRef<HTMLElement>(null);
  const intro = useRef<HTMLDivElement>(null);
  const events = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const measure = () => setScrollMargin(events.current?.offsetTop ?? 0);
    measure();
    const observer = new ResizeObserver(measure);
    if (intro.current) observer.observe(intro.current);
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  const [expansion, setExpansion] = useState<{ indexed: Indexed; values: Map<string, boolean> }>({
    indexed,
    values: new Map(),
  });
  const virtual = useVirtualizer({
    count: layout.rows.length,
    getScrollElement: () => box.current,
    getItemKey: (i) => layout.rows[i]?.key ?? i,
    estimateSize: (i) => (layout.rows[i]?.kind === "header" ? 64 : 120),
    overscan: 6,
    paddingEnd: 240,
    scrollMargin,
    initialRect: { width: 600, height: 600 },
  });
  const previousQuery = useRef(query);
  const previousJump = useRef(jump);
  useLayoutEffect(() => {
    const searching = query !== previousQuery.current;
    previousQuery.current = query;
    const navigating = jump !== previousJump.current;
    previousJump.current = jump;
    if (!searching && !navigating && !followSelection.current) {
      followSelection.current = true;
      return;
    }
    const target =
      searching && query && layout.firstMatch !== undefined
        ? layout.firstMatch
        : layout.starts.get(selected);
    if (target !== undefined) virtual.scrollToIndex(target, { align: "start" });
  }, [layout, query, selected, jump, virtual, followSelection]);
  const linked = indexed.some(({ turn }) => turn.sessionStepIds?.length);
  const selectedTurn = indexed.find(({ turn }) => turn.index === selected)?.turn;
  return (
    <main className="conv-main" ref={box} aria-label="Conversation messages">
      <div className="conv-intro" ref={intro}>
        <div className="conv-source faint">
          Messages, tool results and states come from the saved evaluation record. The Agent session
          tab has the agent's full session.
        </div>
        {linked && (
          <section aria-label="Agent at this turn">
            <h3>Agent at this turn</h3>
            <SessionSteps stepIds={selectedTurn?.sessionStepIds ?? []} messages={messages} />
          </section>
        )}
      </div>
      <div
        ref={events}
        className="conv-events"
        style={{ height: virtual.getTotalSize(), position: "relative" }}
      >
        {virtual.getVirtualItems().map((item) => {
          const row = layout.rows[item.index];
          if (!row) return null;
          const { turn } = row;
          const event = row.kind === "event" ? row.event : undefined;
          const open = expansion.indexed === indexed ? expansion.values.get(row.key) : undefined;
          const expanded =
            open ??
            (turn.check?.status === "failed" ||
              (event?.type === "tool_call" && event.status !== "ok"));
          return (
            <div
              key={item.key}
              data-index={item.index}
              data-event-key={event ? row.key : undefined}
              ref={virtual.measureElement}
              style={{
                position: "absolute",
                width: "100%",
                top: 0,
                transform: `translateY(${item.start - scrollMargin}px)`,
              }}
            >
              <section
                id={row.kind === "header" ? `turn-${turn.index}` : undefined}
                className={`conv-turn conv-row ${row.kind}${row.last ? " last" : ""}${turn.index === selected ? " on" : ""} st-${turn.check?.status ?? "none"}`}
                onClick={() => turn.index !== selected && onSelect(turn.index, false)}
              >
                {row.kind === "header" && (
                  <>
                    <header>
                      <b>{whole ? "Conversation" : `Turn ${turn.index + 1}`}</b>
                      {turn.check && (
                        <span className={`conv-check st-${turn.check.status}`}>
                          {STATUS_ICON[turn.check.status]} {turn.check.status}
                        </span>
                      )}
                      {turn.check?.status === "unchecked" && failed !== null && (
                        <span className="faint">
                          not checked: the checker stopped at turn {failed + 1}
                        </span>
                      )}
                      {turn.note && <span className="conv-note">{turn.note}</span>}
                    </header>
                    {turn.check?.status === "failed" && turn.check.detail && (
                      <div className="conv-fail">
                        <IconAlert size={13} /> {turn.check.detail}
                      </div>
                    )}
                  </>
                )}
                {row.kind === "empty" && (
                  <div className="faint conv-none">
                    {query
                      ? "No matching events in this turn."
                      : turn.events.length === 0 && whole
                        ? "No messages or tool calls: this is the expected behavior of the do-nothing baseline."
                        : "No events in this turn."}
                  </div>
                )}
                {event?.type === "message" && (
                  <Message actor={event.actor} text={event.text} label={label} />
                )}
                {event?.type === "tool_call" && (
                  <CallCard
                    call={event}
                    label={label}
                    open={expanded}
                    onToggle={() => {
                      if (!expanded && turn.index !== selected) onSelect(turn.index, false);
                      setExpansion((previous) => {
                        const values = new Map(previous.indexed === indexed ? previous.values : []);
                        values.set(row.key, !expanded);
                        return { indexed, values };
                      });
                    }}
                  />
                )}
              </section>
            </div>
          );
        })}
      </div>
      {indexed.length === 0 && <Empty title="The conversation has no turns" />}
    </main>
  );
}
