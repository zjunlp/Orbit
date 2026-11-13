import {
  type AtifTrajectory,
  ConversationTrajectory,
  type EnvironmentByKind,
  type EnvironmentKind,
  EpisodeTrajectory,
  GuiTrajectory,
} from "../contracts/index.ts";
import { projectTranscript } from "./projection.ts";

const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value ?? null;
}
const stable = (value: unknown): string => JSON.stringify(canonical(value));

/** Decode CLI tool-result envelopes; do not search arbitrary message text for identifiers. */
function resultObjects(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 5) return [];
  if (typeof value === "string") {
    try {
      return resultObjects(JSON.parse(value), depth + 1);
    } catch {
      return value.split("\n").flatMap((line) => {
        try {
          return resultObjects(JSON.parse(line), depth + 1);
        } catch {
          return [];
        }
      });
    }
  }
  if (Array.isArray(value)) return value.flatMap((v) => resultObjects(v, depth + 1));
  const v = object(value);
  return [
    v,
    ...[v.content, v.text, v.output].flatMap((x) =>
      x === undefined ? [] : resultObjects(x, depth + 1),
    ),
  ];
}

/** A read-time projection. Original environment files and scoring evidence remain immutable. */
export function alignEnvironment<K extends EnvironmentKind>(
  kind: K,
  value: unknown,
  trajectory: AtifTrajectory | null,
  sessionRunId: string,
): EnvironmentByKind[K] {
  const trace =
    kind === "gui"
      ? GuiTrajectory.parse(value)
      : kind === "episode"
        ? EpisodeTrajectory.parse(value)
        : ConversationTrajectory.parse(value);
  const steps = (trajectory?.steps ?? []).filter((step) => !step.is_copied_context);
  const ids = new Set(steps.map((s) => s.step_id));
  const check = (refs: number[] | undefined) =>
    [...new Set(refs ?? [])].filter((id) => ids.has(id)).slice(0, 200);
  const calls = steps.flatMap((step) => (step.tool_calls ?? []).map((call) => ({ step, call })));
  const messages = trajectory ? projectTranscript(trajectory).messages : [];
  const truncated =
    trace.completeness === "truncated" || trajectory?.extra?.orbit?.completeness === "truncated";
  const completeness = truncated ? "truncated" : trajectory ? "complete" : "environment-only";
  if (kind === "gui" && "steps" in trace) {
    const actions = new Map<string, Set<number>>();
    for (const step of steps)
      for (const result of step.observation?.results ?? []) {
        if (
          !result.source_call_id ||
          !step.tool_calls?.some((call) => call.tool_call_id === result.source_call_id)
        )
          continue;
        for (const v of resultObjects(result.content))
          if (typeof v.id === "string" && Number.isSafeInteger(v.step)) {
            const key = `${v.step}:${v.id}`;
            const own = actions.get(key) ?? new Set<number>();
            own.add(step.step_id);
            actions.set(key, own);
          }
      }
    trace.steps = trace.steps.map((row) => {
      const matched = actions.get(`${row.step}:${row.actionId}`);
      return {
        ...row,
        sessionStepIds:
          row.sessionStepIds !== undefined
            ? check(row.sessionStepIds)
            : matched?.size === 1
              ? [...matched]
              : [],
      };
    });
  } else if (kind === "episode" && "samples" in trace) {
    trace.samples = trace.samples.map((row) => ({
      ...row,
      sessionStepIds:
        row.sessionStepIds !== undefined
          ? check(row.sessionStepIds)
          : check(
              row.sessionMessageIndexes?.flatMap((i) =>
                messages[i]?.stepId ? [messages[i].stepId] : [],
              ),
            ),
    }));
  } else if (kind === "conversation" && "turns" in trace) {
    const signature = (name: string, args: unknown) => `${name}:${stable(args)}`;
    const byId = new Map<string, typeof calls>();
    const bySignature = new Map<string, typeof calls>();
    for (const item of calls) {
      const { call } = item;
      byId.set(call.tool_call_id, [...(byId.get(call.tool_call_id) ?? []), item]);
      const wrapper = /(?:^|__)call_function$/.test(call.function_name);
      const key = signature(
        wrapper ? String(call.arguments.name) : call.function_name,
        wrapper ? call.arguments.arguments : call.arguments,
      );
      bySignature.set(key, [...(bySignature.get(key) ?? []), item]);
    }
    const textOf = (value: (typeof steps)[number]["message"]) =>
      typeof value === "string"
        ? value
        : value
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("\n");
    const messageKey = (actor: string, text: string) => {
      const role = trace.participants.find((p) => p.id === actor)?.role;
      return role === "agent" || role === "user" ? `${role}:${text}` : null;
    };
    const nativeMessages = new Map<string, number[]>();
    for (const step of steps) {
      const text = textOf(step.message);
      if (!text || (step.source !== "agent" && step.source !== "user")) continue;
      const key = `${step.source}:${text}`;
      nativeMessages.set(key, [...(nativeMessages.get(key) ?? []), step.step_id]);
    }
    const messageCounts = new Map<string, number>();
    for (const turn of trace.turns)
      for (const event of turn.events)
        if (event.type === "message") {
          const key = messageKey(event.actor, event.text);
          if (key) messageCounts.set(key, (messageCounts.get(key) ?? 0) + 1);
        }
    const occurrences = new Map<string, number>();
    for (const turn of trace.turns)
      for (const e of turn.events)
        if (
          e.type === "tool_call" &&
          trace.participants.some((p) => p.id === e.actor && p.role === "agent")
        ) {
          const key = signature(e.name, e.arguments);
          occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
        }
    trace.turns = trace.turns.map((turn) => {
      if (turn.sessionStepIds !== undefined)
        return { ...turn, sessionStepIds: check(turn.sessionStepIds) };
      const refs = turn.events.flatMap((e) => {
        if (e.type === "message") {
          const key = messageKey(e.actor, e.text);
          const matches = key ? nativeMessages.get(key) : undefined;
          return key && messageCounts.get(key) === 1 && matches?.length === 1 ? matches : [];
        }
        if (
          e.type !== "tool_call" ||
          !trace.participants.some((p) => p.id === e.actor && p.role === "agent")
        )
          return [];
        let found = byId.get(e.id) ?? [];
        if (!found.length && occurrences.get(signature(e.name, e.arguments)) === 1)
          found = bySignature.get(signature(e.name, e.arguments)) ?? [];
        return found.length === 1 && found[0] ? [found[0].step.step_id] : [];
      });
      return { ...turn, sessionStepIds: check(refs) };
    });
  }
  return { ...trace, completeness, sessionRunId } as EnvironmentByKind[K];
}
