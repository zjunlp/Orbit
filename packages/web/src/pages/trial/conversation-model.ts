import type { ConversationEvent } from "@zjunlp/orbit/contracts";
import { type Conversation, searchText, type Turn, turnStats } from "../../lib/conversation.ts";

export function indexConversation(c: Conversation) {
  return c.turns.map((turn) => ({
    turn,
    stats: turnStats(turn),
    events: turn.events.map((event, index) => ({
      event,
      key: `${turn.index}:event:${index}`,
      text: searchText(event),
    })),
  }));
}

export type ConversationRow = {
  key: string;
  turn: Turn;
  last: boolean;
} & ({ kind: "header" } | { kind: "empty" } | { kind: "event"; event: ConversationEvent });

/** Flatten at event granularity so a single enormous turn is also bounded by the viewport. */
export function conversationRows(
  index: ReturnType<typeof indexConversation>,
  query: string,
  onlyTurn?: number,
) {
  const rows: ConversationRow[] = [];
  const starts = new Map<number, number>();
  const q = query.toLowerCase();
  let hits = 0;
  let firstMatch: number | undefined;
  for (const { turn, events } of index) {
    if (onlyTurn !== undefined && turn.index !== onlyTurn) continue;
    starts.set(turn.index, rows.length);
    rows.push({ kind: "header", key: `${turn.index}:header`, turn, last: false });
    const shown = q ? events.filter((e) => e.text.includes(q)) : events;
    if (shown.length) {
      firstMatch ??= rows.length;
      hits += shown.length;
      for (const [i, { key, event }] of shown.entries())
        rows.push({ kind: "event", key, turn, event, last: i === shown.length - 1 });
    } else {
      rows.push({ kind: "empty", key: `${turn.index}:empty`, turn, last: true });
    }
  }
  return { rows, starts, hits, firstMatch };
}
