import { createHash } from "node:crypto";
import type { AtifContentPart, AtifMetrics, AtifStep, AtifTrajectory } from "../contracts/atif.ts";
import {
  collectImage,
  nativeMetadata,
  parseNativeJsonl,
  type TrajectoryConversion,
  type TrajectoryMedia,
  type TrajectoryOptions,
} from "./atif.ts";

export interface ClaudeSubagentInput {
  input: string;
  agentId: string;
  toolUseId?: string;
  sourcePath?: string;
}

export interface ClaudeTrajectoryOptions extends TrajectoryOptions {
  subagents?: ClaudeSubagentInput[];
}

type NativeEvent = { value: Record<string, unknown>; line: number };
type NativeIssue = { line: number; type: string };
type Content = string | AtifContentPart[];
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const bookkeeping = new Set([
  "api-request",
  "api-request-blob",
  "api-request-shape",
  "atis-latch",
  "cost-state",
  "last-prompt",
  "queue-operation",
  "tools-used",
  "file-history-snapshot",
  "file-history-delta",
  "mode",
  "permission-mode",
  "ai-title",
  "agent-name",
  "custom-title",
  "continued-in",
  "summary",
  "progress",
]);
const systemKinds = new Set([
  "api_error",
  "informational",
  "local_command",
  "scheduled_task_fire",
  "turn_duration",
  "away_summary",
]);

function append(left: Content, right: Content): Content {
  if (typeof left === "string" && typeof right === "string")
    return [left, right].filter(Boolean).join("\n");
  const parts = (value: Content): AtifContentPart[] =>
    typeof value === "string" ? (value ? [{ type: "text", text: value }] : []) : value;
  return [...parts(left), ...parts(right)];
}

function activeChain(events: NativeEvent[], issues: NativeIssue[]): NativeEvent[] {
  const byId = new Map<string, NativeEvent[]>();
  for (const event of events) {
    const id = string(event.value.uuid);
    if (id) {
      const versions = byId.get(id) ?? [];
      versions.push(event);
      byId.set(id, versions);
    }
  }
  const last = events.findLast(
    (event) => typeof event.value.uuid === "string" && !bookkeeping.has(String(event.value.type)),
  );
  if (!last) return events;
  const selected = new Set<NativeEvent>();
  let current: NativeEvent | undefined = last;
  while (current) {
    selected.add(current);
    const parents: string[] = [
      string(current.value.parentUuid),
      string(current.value.logicalParentUuid),
    ].filter((id): id is string => !!id);
    if (!parents.length) break;
    const before: number = current.line;
    // Compaction may append preserved copies with the same UUID after their original parent.
    const next: NativeEvent | undefined = parents
      .map((id): NativeEvent | undefined => byId.get(id)?.findLast((event) => event.line < before))
      .find(Boolean);
    if (!next) {
      issues.push({ line: current.line, type: "missing_parent" });
      break;
    }
    current = next;
  }
  const messageIds = new Set<string>();
  for (const event of selected) {
    const id = string(object(event.value.message).id);
    if (event.value.type === "assistant" && id) messageIds.add(id);
  }
  // Parallel blocks and results are siblings, not necessarily ancestors of the next message.
  for (const event of events) {
    const id = string(object(event.value.message).id);
    if (event.value.type === "assistant" && id && messageIds.has(id)) selected.add(event);
  }
  const callIds = new Set<string>();
  for (const event of selected) {
    if (event.value.type !== "assistant") continue;
    const content = object(event.value.message).content;
    if (!Array.isArray(content)) continue;
    for (const raw of content) {
      const block = object(raw);
      const id = string(block.id);
      if (block.type === "tool_use" && id) callIds.add(id);
    }
  }
  const siblingResults = new Map<NativeEvent, unknown[]>();
  for (const event of events) {
    if (event.value.type !== "user" || selected.has(event)) continue;
    const content = object(event.value.message).content;
    if (!Array.isArray(content)) continue;
    const relevant = content.filter((raw) => {
      const block = object(raw);
      return (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        callIds.has(block.tool_use_id)
      );
    });
    if (relevant.length) {
      selected.add(event);
      siblingResults.set(event, relevant);
    }
  }
  const selectedById = new Map<string, NativeEvent>();
  for (const event of events)
    if (selected.has(event)) selectedById.set(String(event.value.uuid), event);
  return events
    .filter(
      (event) => !string(event.value.uuid) || selectedById.get(String(event.value.uuid)) === event,
    )
    .map((event) => {
      const content = siblingResults.get(event);
      return content
        ? {
            ...event,
            value: { ...event.value, message: { ...object(event.value.message), content } },
          }
        : event;
    });
}

/** Native JSONL remains the source of truth; conversion never reads or writes files. */
export function convertClaudeTrajectory(
  input: string,
  options: ClaudeTrajectoryOptions = {},
): TrajectoryConversion {
  return convertClaude(input, options, false);
}

function convertClaude(
  input: string,
  options: ClaudeTrajectoryOptions,
  childContext: boolean,
  nativeEvents?: NativeEvent[],
): TrajectoryConversion {
  const parsed = nativeEvents ? { events: nativeEvents, issues: [] } : parseNativeJsonl(input);
  const issues: NativeIssue[] = [...parsed.issues];
  const media: TrajectoryMedia[] = [];
  const embedded = new Map<string, NativeEvent[]>();
  const main: NativeEvent[] = [];
  for (const event of parsed.events) {
    if (event.value.isSidechain === true && !childContext) {
      const id = string(event.value.agentId) ?? "sidechain";
      const events = embedded.get(id) ?? [];
      events.push(event);
      embedded.set(id, events);
    } else main.push(event);
  }
  const rows = activeChain(main, issues);
  const sessionId =
    options.sessionId ??
    rows.map((row) => string(row.value.sessionId)).find(Boolean) ??
    "claude-session";
  const versions = [
    ...new Set(
      rows
        .map((row) => string(row.value.version))
        .filter((version): version is string => !!version),
    ),
  ];
  const cliVersion = options.cliVersion ?? versions.at(-1) ?? "unknown";
  const steps: AtifStep[] = [];
  const messages = new Map<string, AtifStep>();
  const calls = new Map<string, AtifStep>();
  const results = new Map<string, string>();
  const childCalls = new Map<string, string>();
  const unknown: { line: number; value: unknown }[] = [];
  const metadata: { line: number; value: unknown }[] = [];
  let boundary: AtifStep | undefined;

  function unsupported(value: unknown, event: NativeEvent, type = "unknown_event") {
    issues.push({ line: event.line, type });
    unknown.push({ line: event.line, value: nativeMetadata(value) });
  }
  function step(source: AtifStep["source"], event: NativeEvent): AtifStep {
    const at = string(event.value.timestamp);
    const value: AtifStep = {
      step_id: steps.length + 1,
      source,
      message: "",
      ...(at && Number.isFinite(Date.parse(at)) ? { timestamp: at } : {}),
      extra: {
        orbit: {
          native: {
            ...(string(event.value.uuid) ? { id: String(event.value.uuid) } : {}),
            line: event.line,
          },
          reasoning: "none",
        },
      },
    };
    if (at && !Number.isFinite(Date.parse(at)))
      issues.push({ line: event.line, type: "invalid_timestamp" });
    steps.push(value);
    return value;
  }
  function content(value: unknown, event: NativeEvent): Content {
    if (typeof value === "string") return value;
    if (value == null) return "";
    if (!Array.isArray(value)) {
      unsupported(value, event, "unknown_content");
      return "";
    }
    let out: Content = "";
    for (const raw of value) {
      const block = object(raw);
      if (block.type === "text" && typeof block.text === "string") out = append(out, block.text);
      else if (block.type === "image") {
        const image = collectImage(block.source, media);
        if (image) out = append(out, [image]);
        else unsupported(block, event, "unsupported_image");
      } else if (block.type === "tool_reference") metadata.push({ line: event.line, value: block });
      else unsupported(block, event, "unknown_content_block");
    }
    return out;
  }
  function usage(raw: Record<string, unknown>, event: NativeEvent): AtifMetrics {
    function count(name: string, optional = false): number | undefined {
      const value = raw[name];
      if (value == null && optional) return 0;
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
      issues.push({ line: event.line, type: `invalid_usage_${name}` });
      return undefined;
    }
    const input = count("input_tokens");
    const read = count("cache_read_input_tokens", true);
    const write = count("cache_creation_input_tokens", true);
    const output = count("output_tokens");
    return {
      ...(input !== undefined && read !== undefined && write !== undefined
        ? { prompt_tokens: input + read + write }
        : {}),
      ...(output !== undefined ? { completion_tokens: output } : {}),
      ...(read !== undefined ? { cached_tokens: read } : {}),
      extra: { native_usage: nativeMetadata(raw) },
    };
  }
  function compaction(event: NativeEvent): AtifStep {
    const value = step("system", event);
    value.extra = {
      ...value.extra,
      context_management: { type: "compaction", boundary: "replace" },
      orbit: {
        ...value.extra?.orbit,
        ...(event.value.compactMetadata
          ? { metadata: { compact_metadata: nativeMetadata(event.value.compactMetadata) } }
          : {}),
      },
    };
    return value;
  }

  for (const event of rows) {
    const value = event.value;
    const message = object(value.message);
    if (bookkeeping.has(String(value.type))) {
      if (value.type === "cost-state") metadata.push({ line: event.line, value });
      continue;
    }
    if (value.type === "system") {
      if (value.subtype === "compact_boundary") boundary = compaction(event);
      else if (systemKinds.has(String(value.subtype))) {
        const text =
          typeof value.content === "string"
            ? value.content
            : typeof value.message === "string"
              ? value.message
              : message.content;
        if (text) step("system", event).message = content(text, event);
        else metadata.push({ line: event.line, value });
      } else unsupported(value, event);
      continue;
    }
    if (value.type === "attachment") {
      if (Array.isArray(value.rendered)) {
        const rendered = value.rendered
          .map((entry) => object(entry).content)
          .filter((text): text is string => typeof text === "string")
          .join("\n");
        if (rendered)
          step(value.renderedRole === "user" ? "user" : "system", event).message = rendered;
        else metadata.push({ line: event.line, value });
      } else metadata.push({ line: event.line, value });
      continue;
    }
    if (value.type !== "assistant" && value.type !== "user") {
      unsupported(value, event);
      continue;
    }
    if (value.isCompactSummary === true) {
      boundary ??= compaction(event);
      const summary = content(message.content, event);
      boundary.observation ??= { results: [] };
      boundary.observation.results.push({ content: summary });
      boundary = undefined;
      continue;
    }
    if (value.type === "assistant") {
      const id = string(message.id) ?? string(value.uuid) ?? `line-${event.line}`;
      const synthetic = message.model === "<synthetic>" || value.isApiErrorMessage === true;
      let current = messages.get(id);
      if (!current) {
        current = step(synthetic ? "system" : "agent", event);
        if (!synthetic) current.llm_call_count = 1;
        messages.set(id, current);
      }
      if (!synthetic) {
        if (typeof message.model === "string") current.model_name = message.model;
        if (typeof value.effort === "string" || typeof value.effort === "number")
          current.reasoning_effort = value.effort;
        if (message.usage && typeof message.usage === "object")
          current.metrics = usage(object(message.usage), event);
      }
      if (message.stop_reason != null)
        current.extra = {
          ...current.extra,
          orbit: {
            ...current.extra?.orbit,
            metadata: { ...current.extra?.orbit?.metadata, stop_reason: message.stop_reason },
          },
        };
      const blocks =
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : Array.isArray(message.content)
            ? message.content
            : [];
      for (const raw of blocks) {
        const block = object(raw);
        if (block.type === "thinking" || block.type === "redacted_thinking") {
          const orbit = object(current.extra?.orbit);
          if (block.signature || block.type === "redacted_thinking") {
            orbit.reasoning = "opaque";
            delete current.reasoning_content;
          } else if (
            typeof block.thinking === "string" &&
            block.thinking &&
            !synthetic &&
            orbit.reasoning !== "opaque"
          ) {
            orbit.reasoning = "raw";
            current.reasoning_content = [current.reasoning_content, block.thinking]
              .filter(Boolean)
              .join("\n");
          }
          current.extra = { ...current.extra, orbit };
        } else if (block.type === "tool_use" && !synthetic) {
          const callId = string(block.id);
          const name = string(block.name);
          if (!callId || !name) {
            unsupported(block, event, "invalid_tool_call");
            continue;
          }
          if (calls.has(callId)) {
            if (calls.get(callId) !== current) unsupported(block, event, "duplicate_tool_call_id");
            continue;
          }
          current.tool_calls ??= [];
          current.tool_calls.push({
            tool_call_id: callId,
            function_name: name,
            arguments:
              block.input && typeof block.input === "object" && !Array.isArray(block.input)
                ? object(block.input)
                : { input: block.input ?? null },
          });
          calls.set(callId, current);
        } else current.message = append(current.message, content([block], event));
      }
      continue;
    }
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message.content)
          ? message.content
          : [];
    const ordinary: unknown[] = [];
    for (const raw of blocks) {
      const block = object(raw);
      if (block.type !== "tool_result") {
        ordinary.push(raw);
        continue;
      }
      const callId = string(block.tool_use_id);
      const resultKey = JSON.stringify(block);
      if (callId && results.get(callId) === resultKey) continue;
      if (callId && results.has(callId)) {
        unsupported(block, event, "duplicate_tool_result");
        continue;
      }
      const owner = callId ? calls.get(callId) : undefined;
      const resultContent = content(block.content, event);
      if (owner) {
        owner.observation ??= { results: [] };
        owner.observation.results.push({
          source_call_id: callId,
          content: resultContent,
          ...(block.is_error === undefined ? {} : { extra: { is_error: block.is_error } }),
        });
        results.set(callId as string, resultKey);
        const agentId = string(object(value.toolUseResult).agentId);
        if (agentId && callId) childCalls.set(agentId, callId);
      } else {
        issues.push({ line: event.line, type: "orphan_tool_result" });
        step("system", event).observation = {
          results: [{ content: resultContent, extra: { native_tool_use_id: callId ?? null } }],
        };
      }
    }
    if (ordinary.length)
      step(value.isMeta === true ? "system" : "user", event).message = content(ordinary, event);
  }
  for (const [id, owner] of calls) {
    if (!results.has(id))
      issues.push({
        line: Number(object(owner.extra?.orbit?.native).line) || 0,
        type: "missing_tool_result",
      });
  }
  for (const current of steps) {
    if (current.source === "agent" && !current.metrics)
      issues.push({
        line: Number(object(object(current.extra?.orbit).native).line) || 0,
        type: "missing_usage",
      });
  }
  if (!steps.length) throw new Error("Claude session contains no convertible conversation steps");

  const subagents = new Map<string, ClaudeSubagentInput>();
  for (const agentId of embedded.keys())
    subagents.set(agentId, {
      agentId,
      input,
      sourcePath: options.sourcePath ?? "claude.jsonl",
    });
  for (const child of options.subagents ?? []) subagents.set(child.agentId, child);
  const children: AtifTrajectory[] = [];
  for (const child of subagents.values()) {
    try {
      const embeddedRows = options.subagents?.some((entry) => entry.agentId === child.agentId)
        ? undefined
        : embedded.get(child.agentId);
      const converted = convertClaude(
        child.input,
        {
          sessionId,
          sourcePath: child.sourcePath ?? `subagents/${child.agentId}.jsonl`,
          cliVersion,
        },
        true,
        embeddedRows,
      );
      const childId = `${sessionId}:agent:${child.agentId}`;
      converted.trajectory.trajectory_id = childId;
      const childOrbit = object(converted.trajectory.extra?.orbit);
      if (childOrbit.completeness === "truncated")
        issues.push({ line: 0, type: "truncated_subagent" });
      children.push(converted.trajectory);
      for (const asset of converted.media)
        if (!media.some((existing) => existing.path === asset.path)) media.push(asset);
      const callId = child.toolUseId ?? childCalls.get(child.agentId);
      const owner = callId ? calls.get(callId) : undefined;
      const result = owner?.observation?.results.find((item) => item.source_call_id === callId);
      if (result) result.subagent_trajectory_ref = [{ trajectory_id: childId }];
    } catch (error) {
      issues.push({ line: 0, type: "invalid_subagent" });
      metadata.push({
        line: 0,
        value: {
          agent_id: child.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  const totals = {
    total_prompt_tokens: 0,
    total_completion_tokens: 0,
    total_cached_tokens: 0,
    total_steps: steps.length,
  };
  for (const current of steps) {
    totals.total_prompt_tokens += current.metrics?.prompt_tokens ?? 0;
    totals.total_completion_tokens += current.metrics?.completion_tokens ?? 0;
    totals.total_cached_tokens += current.metrics?.cached_tokens ?? 0;
  }
  const agentSteps = steps.filter((current) => current.source === "agent");
  const promptKnown = agentSteps.every((current) => current.metrics?.prompt_tokens != null);
  const completionKnown = agentSteps.every((current) => current.metrics?.completion_tokens != null);
  const cachedKnown = agentSteps.every((current) => current.metrics?.cached_tokens != null);
  const finalMetrics = {
    total_steps: totals.total_steps,
    ...(promptKnown ? { total_prompt_tokens: totals.total_prompt_tokens } : {}),
    ...(completionKnown ? { total_completion_tokens: totals.total_completion_tokens } : {}),
    ...(cachedKnown ? { total_cached_tokens: totals.total_cached_tokens } : {}),
  };
  const trajectory: AtifTrajectory = {
    schema_version: "ATIF-v1.7",
    session_id: sessionId,
    trajectory_id: sessionId,
    agent: { name: "claude-code", version: cliVersion },
    steps,
    final_metrics: finalMetrics,
    ...(children.length ? { subagent_trajectories: children } : {}),
    extra: {
      orbit: {
        version: 1,
        ...(options.run ? { run: options.run } : {}),
        importer: { name: "claude-jsonl", version: 1 },
        sources: [
          {
            path: options.sourcePath ?? "claude.jsonl",
            sha256: createHash("sha256").update(input).digest("hex"),
            bytes: Buffer.byteLength(input),
          },
        ],
        completeness: issues.length ? "truncated" : "agent-only",
        cli_version: cliVersion,
        ...(unknown.length ? { unknown_events: unknown } : {}),
        ...(versions.length > 1 ? { cli_versions: versions } : {}),
        metadata: {
          ...(!promptKnown || !completionKnown || !cachedKnown
            ? { partial_token_totals: totals }
            : {}),
          ...(issues.length ? { conversion_issues: issues } : {}),
          ...(metadata.length ? { native_metadata: nativeMetadata(metadata) } : {}),
          ...(main.length !== rows.length
            ? { excluded_branch_records: main.length - rows.length }
            : {}),
        },
      },
    },
  };
  return { trajectory, media };
}
