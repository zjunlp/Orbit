// Pure helpers for the C3/C4 conversation view (design §9.15): parse a saved
// `ConversationTrajectory`, flatten states to paths and diff them, summarize tool calls.
import type { ConversationEvent, ConversationTrajectory } from "@zjunlp/orbit/contracts";

export type Conversation = ConversationTrajectory;
export type Turn = Conversation["turns"][number];
export type ToolCall = Extract<ConversationEvent, { type: "tool_call" }>;

/** A saved conversation, checked enough to render (the verifier wrote it; the schema is shared). */
export function parseConversation(text: string): Conversation {
  const v = JSON.parse(text) as Partial<Conversation>;
  if (v?.version !== 1 || v.kind !== "conversation" || !Array.isArray(v.turns))
    throw new Error("Not a version 1 conversation trajectory");
  if (!Array.isArray(v.participants) || !v.verdict) throw new Error("Malformed conversation");
  for (const t of v.turns)
    if (!Array.isArray(t.events) || typeof t.index !== "number")
      throw new Error("Malformed conversation turn");
  return { ...(v as Conversation), verdict: { ...v.verdict, checks: v.verdict.checks ?? [] } };
}

/** `{a: {b: [1]}}` → `{"a.b[0]": 1}`; empty objects and arrays stay leaves. */
export function flatten(value: unknown, prefix = "", out: Record<string, unknown> = {}) {
  if (value && typeof value === "object" && Object.keys(value).length) {
    if (Array.isArray(value))
      for (const [i, v] of value.entries()) flatten(v, `${prefix}[${i}]`, out);
    else for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else out[prefix] = value;
  return out;
}

export interface StateRow {
  path: string;
  before?: unknown;
  after?: unknown;
  expected?: unknown;
  /** The turn changed this path. */
  changed: boolean;
  /** After differs from expected (only when an expected state exists). */
  mismatch: boolean;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Paths that changed in the turn or differ from the expected state; unchanged matching paths are
 * left out. `has` keys tell a missing path from a `null` value.
 */
export function diffStates(before: unknown, after: unknown, expected?: unknown): StateRow[] {
  const b = flatten(before);
  const a = flatten(after);
  const e = expected === undefined ? null : flatten(expected);
  const paths = [...new Set([...Object.keys(b), ...Object.keys(a), ...Object.keys(e ?? {})])];
  const rows: StateRow[] = [];
  for (const path of paths.sort()) {
    const changed = !(path in b && path in a && same(b[path], a[path])) && (path in b || path in a);
    const mismatch = e !== null && !(path in a && path in e && same(a[path], e[path]));
    if (!changed && !mismatch) continue;
    rows.push({
      path,
      ...(path in b ? { before: b[path] } : {}),
      ...(path in a ? { after: a[path] } : {}),
      ...(e && path in e ? { expected: e[path] } : {}),
      changed,
      mismatch,
    });
  }
  return rows;
}

/** One line for a value: strings as they are, everything else as compact JSON. */
export function brief(v: unknown, max = 80): string {
  const s = typeof v === "string" ? v : v === undefined ? "—" : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** `name(a=1, b="x")` from a call's arguments (positional ones are `#0`, `#1`, ...). */
export function callSummary(c: Pick<ToolCall, "name" | "arguments">, max = 120): string {
  const args =
    c.arguments && typeof c.arguments === "object" && !Array.isArray(c.arguments)
      ? Object.entries(c.arguments as Record<string, unknown>)
          .map(([k, v]) => (k.startsWith("#") ? brief(v, 40) : `${k}=${brief(v, 40)}`))
          .join(", ")
      : brief(c.arguments, 60);
  const s = `${c.name}(${args})`;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A result string that holds JSON, parsed; anything else unchanged. */
export function parseResult(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!/^[[{]/.test(t)) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

export interface TurnStats {
  calls: number;
  errors: number;
  rejected: number;
  preview: string;
}

export function turnStats(t: Turn): TurnStats {
  const calls = t.events.filter((e): e is ToolCall => e.type === "tool_call");
  const first = t.events.find((e) => e.type === "message");
  return {
    calls: calls.length,
    errors: calls.filter((c) => c.status === "error").length,
    rejected: calls.filter((c) => c.status === "rejected").length,
    preview: first?.type === "message" ? first.text : (t.note ?? ""),
  };
}

/** Whether a turn or event contains `q` (case-insensitive) in its text, call or result. */
export function matches(e: ConversationEvent, q: string): boolean {
  if (!q) return true;
  const hay =
    e.type === "message"
      ? e.text
      : `${e.name} ${JSON.stringify(e.arguments)} ${typeof e.result === "string" ? e.result : JSON.stringify(e.result ?? "")} ${e.error ?? ""}`;
  return hay.toLowerCase().includes(q.toLowerCase());
}

/** Strings holding JSON (as checkers often report results) parsed, at any depth. */
export function deepParse(v: unknown, depth = 0): unknown {
  if (depth > 8) return v;
  const p = parseResult(v);
  if (Array.isArray(p)) return p.map((x) => deepParse(x, depth + 1));
  if (p && typeof p === "object")
    return Object.fromEntries(Object.entries(p).map(([k, x]) => [k, deepParse(x, depth + 1)]));
  return p;
}
