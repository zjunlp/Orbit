import {
  type AtifContentPart,
  AtifTrajectory,
  ChatTrajectory,
  type TrajectoryExportRequest,
} from "../../contracts/index.ts";

import { TrajectoryExportError } from "./security.ts";

export const EXPORT_MEDIA_PATH =
  /^media\/[a-f0-9]{64}\.(png|jpg|gif|webp|wav|mp3|m4a|aac|ogg|flac|weba|aiff)$/;
const PRIVATE_REASONING =
  /(?:encrypted|signature|opaque|redacted_thinking)|^(?:reasoning|reasoning_content|raw_reasoning|thinking|analysis)$/i;

/** Only the standard reasoning_content field is eligible for the requested reasoning policy. */
function cleanExtra(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanExtra).filter((item) => item !== undefined);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.type === "string" && /^(?:reasoning|thinking|redacted_thinking)$/.test(obj.type))
      return undefined;
    return Object.fromEntries(
      Object.entries(obj)
        .filter(([key]) => !PRIVATE_REASONING.test(key))
        .map(([key, item]) => [key, cleanExtra(item)]),
    );
  }
  return value;
}

export function prepareTrajectory(
  input: AtifTrajectory,
  reasoning: TrajectoryExportRequest["reasoning"],
): AtifTrajectory {
  const value = structuredClone(input);
  const visit = (t: AtifTrajectory) => {
    t.extra = cleanExtra(t.extra) as AtifTrajectory["extra"];
    t.agent.extra = cleanExtra(t.agent.extra) as typeof t.agent.extra;
    if (t.final_metrics)
      t.final_metrics.extra = cleanExtra(t.final_metrics.extra) as typeof t.final_metrics.extra;
    for (const step of t.steps) {
      const kind = step.extra?.orbit?.reasoning;
      const keep =
        kind !== "opaque" &&
        kind !== "none" &&
        (reasoning === "raw" || (reasoning === "summary" && kind === "summary"));
      if (!keep) delete step.reasoning_content;
      step.extra = cleanExtra(step.extra) as typeof step.extra;
      if (step.extra?.orbit && kind)
        step.extra.orbit.reasoning = step.reasoning_content
          ? kind === "summary"
            ? "summary"
            : "raw"
          : "none";
      if (step.metrics)
        step.metrics.extra = cleanExtra(step.metrics.extra) as typeof step.metrics.extra;
      for (const call of step.tool_calls ?? [])
        call.extra = cleanExtra(call.extra) as typeof call.extra;
      for (const result of step.observation?.results ?? []) {
        result.extra = cleanExtra(result.extra) as typeof result.extra;
        for (const ref of result.subagent_trajectory_ref ?? []) {
          ref.extra = cleanExtra(ref.extra) as typeof ref.extra;
          if (ref.trajectory_path)
            throw new TrajectoryExportError(
              `external subagent file at step ${step.step_id}; embed it before export`,
            );
        }
      }
    }
    for (const child of t.subagent_trajectories ?? []) visit(child);
  };
  visit(value);
  return AtifTrajectory.parse(value);
}

export function trajectoryMedia(t: AtifTrajectory): string[] {
  const paths = new Set<string>();
  const content = (value: string | AtifContentPart[] | null | undefined) => {
    if (!Array.isArray(value)) return;
    for (const part of value) {
      if (part.type === "text") continue;
      if (!EXPORT_MEDIA_PATH.test(part.source.path))
        throw new TrajectoryExportError("unsafe or unavailable trajectory media path");
      paths.add(part.source.path);
    }
  };
  const visit = (value: AtifTrajectory) => {
    for (const step of value.steps) {
      content(step.message);
      for (const result of step.observation?.results ?? []) content(result.content);
    }
    for (const child of value.subagent_trajectories ?? []) visit(child);
  };
  visit(t);
  return [...paths].sort();
}

export function chatTrajectories(
  t: AtifTrajectory,
  run: string,
  mediaPrefix: string,
): ChatTrajectory[] {
  const rows: ChatTrajectory[] = [];
  const content = (value: string | AtifContentPart[]): string | AtifContentPart[] => {
    if (typeof value === "string") return value;
    return value.map((part) => {
      const copy = structuredClone(part);
      if (copy.type !== "text") copy.source.path = `${mediaPrefix}/${copy.source.path}`;
      return copy;
    });
  };
  const visit = (value: AtifTrajectory, parent: string | null) => {
    const messages: ChatTrajectory["messages"] = [];
    for (const step of value.steps) {
      messages.push({
        step_id: step.step_id,
        role: step.source === "agent" ? "assistant" : step.source,
        content: content(step.message),
        ...(step.reasoning_content ? { reasoning_content: step.reasoning_content } : {}),
        ...(step.tool_calls?.length
          ? {
              tool_calls: step.tool_calls.map((call) => ({
                id: call.tool_call_id,
                type: "function" as const,
                function: { name: call.function_name, arguments: JSON.stringify(call.arguments) },
              })),
            }
          : {}),
      });
      for (const result of step.observation?.results ?? [])
        messages.push({
          step_id: step.step_id,
          role: result.source_call_id ? "tool" : "user",
          content: content(result.content ?? ""),
          ...(result.source_call_id
            ? { tool_call_id: result.source_call_id }
            : { observation: true }),
        });
    }
    const id = value.trajectory_id ?? value.session_id ?? null;
    rows.push(
      ChatTrajectory.parse({
        run,
        trajectory_id: id,
        parent_trajectory_id: parent,
        tools: value.agent.tool_definitions ?? [],
        messages,
      }),
    );
    for (const child of value.subagent_trajectories ?? []) visit(child, id);
  };
  visit(t, null);
  return rows;
}

export function trajectoryCounts(t: AtifTrajectory): { steps: number; trajectories: number } {
  const children = (t.subagent_trajectories ?? []).map(trajectoryCounts);
  return {
    steps: t.steps.length + children.reduce((n, c) => n + c.steps, 0),
    trajectories: 1 + children.reduce((n, c) => n + c.trajectories, 0),
  };
}
