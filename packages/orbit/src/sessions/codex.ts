import { createHash } from "node:crypto";
import {
  type AtifContentPart,
  type AtifFinalMetrics,
  type AtifMetrics,
  AtifStep,
  AtifTrajectory,
} from "../contracts/atif.ts";
import {
  collectImage,
  nativeMetadata,
  parseNativeJsonl,
  type TrajectoryConversion,
  type TrajectoryMedia,
  type TrajectoryOptions,
} from "./atif.ts";

export type CodexTrajectoryOptions = TrajectoryOptions;

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const TOKEN_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "reasoning_output_tokens",
  "total_tokens",
] as const;

function usageMetrics(usage: Record<string, unknown>): AtifMetrics {
  return {
    ...(count(usage.input_tokens) !== undefined
      ? { prompt_tokens: count(usage.input_tokens) }
      : {}),
    ...(count(usage.output_tokens) !== undefined
      ? { completion_tokens: count(usage.output_tokens) }
      : {}),
    ...(count(usage.cached_input_tokens) !== undefined
      ? { cached_tokens: count(usage.cached_input_tokens) }
      : {}),
    extra: { orbit: { native_usage: usage } },
  };
}

function totalsKey(usage: Record<string, unknown>): string | null {
  return TOKEN_FIELDS.some((key) => count(usage[key]) !== undefined)
    ? JSON.stringify(TOKEN_FIELDS.map((key) => usage[key] ?? null))
    : null;
}

function appendContent(step: AtifStep, content: string | AtifContentPart[]): void {
  if (typeof step.message === "string" && typeof content === "string") {
    step.message += `${step.message && content ? "\n" : ""}${content}`;
    return;
  }
  const parts = (value: string | AtifContentPart[]) =>
    typeof value === "string" ? (value ? [{ type: "text" as const, text: value }] : []) : value;
  step.message = [...parts(step.message), ...parts(content)];
}

/** Convert one native rollout without reading files or changing the source. */
export function convertCodexTrajectory(
  input: string,
  options: TrajectoryOptions = {},
): TrajectoryConversion {
  const parsed = parseNativeJsonl(input);
  const media: TrajectoryMedia[] = [];
  const steps: AtifStep[] = [];
  const metadata: { line: number; event: Record<string, unknown> }[] = [];
  const unsupported: { line: number; type: string; value?: unknown }[] = [...parsed.issues];
  const meta = object(
    parsed.events.find(({ value }) => value.type === "session_meta")?.value.payload,
  );
  const copiedPrefix = count(meta.subagent_history_start_ordinal);
  const isSubagent = Object.keys(object(object(meta.source).subagent)).length > 0;
  if (isSubagent && copiedPrefix === undefined)
    unsupported.push({ line: 1, type: "subagent_prefix_unknown" });
  const versions = new Set<string>();
  if (options.cliVersion) versions.add(options.cliVersion);
  const hash = createHash("sha256").update(input).digest("hex");
  const sessionId =
    options.sessionId || text(meta.id) || text(meta.session_id) || `codex-${hash.slice(0, 24)}`;
  let active: AtifStep | undefined;
  let model = "";
  let effort = "";
  let turnId = "";
  let previousTotal: string | null = null;
  let mayResetUsage = false;
  let uncertainPrefix = isSubagent && copiedPrefix === undefined;
  let reportedTotal: Record<string, unknown> | undefined;
  const calls = new Map<string, AtifStep>();
  const answered = new Set<string>();

  const issue = (line: number, type: string, value?: unknown) => {
    unsupported.push({
      line,
      type,
      ...(value === undefined ? {} : { value: nativeMetadata(value) }),
    });
  };
  const makeStep = (source: AtifStep["source"], line: number, event: Record<string, unknown>) => {
    const payload = object(event.payload);
    const timestamp = text(event.timestamp);
    const validTimestamp =
      Boolean(timestamp) && AtifStep.shape.timestamp.safeParse(timestamp).success;
    const step: AtifStep = {
      step_id: steps.length + 1,
      source,
      message: "",
      ...(validTimestamp ? { timestamp } : {}),
      extra: {
        orbit: {
          native: {
            line,
            ...(text(payload.id) || turnId ? { id: text(payload.id) || turnId } : {}),
          },
          reasoning: "none",
        },
      },
    };
    if (timestamp && !validTimestamp) issue(line, "invalid_timestamp", timestamp);
    if (source === "agent") {
      if (model) step.model_name = model;
      if (effort) step.reasoning_effort = effort;
    }
    steps.push(step);
    return step;
  };
  const agentStep = (line: number, event: Record<string, unknown>) => {
    active ??= makeStep("agent", line, event);
    return active;
  };
  const content = (value: unknown, line: number): string | AtifContentPart[] => {
    if (typeof value === "string") return value;
    if (!Array.isArray(value))
      return value === undefined || value === null ? "" : JSON.stringify(value);
    const parts: AtifContentPart[] = [];
    for (const raw of value) {
      const part = object(raw);
      if (
        ["text", "input_text", "output_text", "summary_text"].includes(text(part.type)) &&
        typeof part.text === "string"
      ) {
        parts.push({ type: "text", text: part.text });
      } else if (["image", "input_image", "output_image"].includes(text(part.type))) {
        const image = collectImage(part.image_url ?? part.url ?? part.source ?? part, media);
        if (image) parts.push(image);
        else issue(line, "unsupported_image", raw);
      } else {
        issue(line, "unsupported_content", raw);
      }
    }
    return parts.every((part) => part.type === "text")
      ? parts.map((part) => part.text ?? "").join("\n")
      : parts;
  };

  for (const { value: event, line } of parsed.events) {
    const payload = object(event.payload);
    if (
      copiedPrefix !== undefined &&
      count(event.ordinal) !== undefined &&
      (count(event.ordinal) ?? 0) < copiedPrefix &&
      event.type !== "session_meta"
    )
      continue;
    if (
      isSubagent &&
      copiedPrefix !== undefined &&
      event.type !== "session_meta" &&
      count(event.ordinal) === undefined
    ) {
      issue(line, "subagent_ordinal_missing");
      uncertainPrefix = true;
    }
    const type = text(payload.type);
    if (event.type === "session_meta") {
      if (text(payload.cli_version)) versions.add(text(payload.cli_version));
      continue;
    }
    if (event.type === "turn_context") {
      model = text(payload.model) || model;
      effort = text(payload.effort) || effort;
      turnId = text(payload.turn_id) || turnId;
      continue;
    }
    if (event.type === "event_msg") {
      if (type === "token_count") {
        const info = object(payload.info);
        const usage = object(info.last_token_usage);
        const total = object(info.total_token_usage);
        const key = totalsKey(total);
        if (key !== null) reportedTotal = total;
        // The CLI repeats the same totals for rate-limit updates and before a new response.
        if (key !== null && key === previousTotal && !(mayResetUsage && active)) continue;
        if (!TOKEN_FIELDS.some((name) => count(usage[name]) !== undefined)) continue;
        if (key === null && !active) continue;
        const step = agentStep(line, event);
        step.metrics = usageMetrics(usage);
        step.llm_call_count = 1;
        if (key !== null) previousTotal = key;
        mayResetUsage = false;
        active = undefined;
      } else if (type === "task_started" || type === "turn_started") {
        active = undefined;
        turnId = text(payload.turn_id);
      } else if (["task_complete", "turn_complete", "turn_aborted"].includes(type)) {
        active = undefined;
        turnId = "";
        if (payload.error || type === "turn_aborted") metadata.push({ line, event });
      } else if (
        [
          "agent_message",
          "agent_reasoning",
          "agent_reasoning_section_break",
          "user_message",
          "item_completed",
          "thread_settings_applied",
          "context_compacted",
        ].includes(type)
      ) {
        // These are notifications of response items already represented in the rollout.
      } else {
        issue(line, `event_msg/${type || "unknown"}`, event);
      }
      continue;
    }
    if (event.type === "compacted") {
      active = undefined;
      const step = makeStep("system", line, event);
      step.message = "Context compacted";
      step.observation = {
        results: [
          {
            content:
              text(payload.message) ||
              JSON.stringify(nativeMetadata(payload.replacement_history ?? [])),
          },
        ],
      };
      step.extra = {
        ...step.extra,
        orbit: {
          ...object(step.extra?.orbit),
          metadata: { native_compaction: nativeMetadata(payload) },
        },
        context_management: { type: "compaction", boundary: "replace" },
      };
      mayResetUsage = true;
      continue;
    }
    if (event.type === "token_usage_record" || event.type === "world_state") {
      metadata.push({ line, event });
      continue;
    }
    if (event.type !== "response_item") {
      issue(line, text(event.type) || "unknown_event", event);
      continue;
    }
    if (type === "message") {
      const role = text(payload.role);
      if (!["assistant", "user", "system", "developer"].includes(role)) {
        issue(line, "unsupported_role", event);
        continue;
      }
      if (role === "assistant") {
        appendContent(agentStep(line, event), content(payload.content, line));
      } else {
        active = undefined;
        const step = makeStep(role === "user" ? "user" : "system", line, event);
        step.message = content(payload.content, line);
      }
    } else if (type === "reasoning") {
      const step = agentStep(line, event);
      const summary = Array.isArray(payload.summary)
        ? payload.summary
            .map((part) => (typeof part === "string" ? part : text(object(part).text)))
            .filter(Boolean)
            .join("\n")
        : "";
      const raw = Array.isArray(payload.content)
        ? payload.content
            .map((part) => text(object(part).text))
            .filter(Boolean)
            .join("\n")
        : "";
      const opaque =
        Boolean(payload.encrypted_content) || object(step.extra?.orbit).reasoning === "opaque";
      const reasoning = opaque ? "" : summary || raw;
      if (opaque) delete step.reasoning_content;
      if (reasoning)
        step.reasoning_content = [step.reasoning_content, reasoning].filter(Boolean).join("\n");
      step.extra = {
        ...step.extra,
        orbit: {
          ...object(step.extra?.orbit),
          reasoning: opaque ? "opaque" : summary ? "summary" : raw ? "raw" : "none",
        },
      };
    } else if (
      type === "function_call" ||
      type === "custom_tool_call" ||
      type === "web_search_call"
    ) {
      const id = text(payload.call_id) || text(payload.id);
      if (!id || calls.has(id)) {
        issue(line, !id ? "missing_call_id" : "duplicate_call_id", event);
        continue;
      }
      const step = agentStep(line, event);
      const raw =
        type === "custom_tool_call"
          ? payload.input
          : type === "web_search_call"
            ? payload.action
            : payload.arguments;
      let args: Record<string, unknown>;
      if (type === "custom_tool_call") args = { input: raw ?? "" };
      else if (typeof raw === "string") {
        try {
          const parsedArgs: unknown = JSON.parse(raw);
          args =
            parsedArgs !== null && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)
              ? object(parsedArgs)
              : { value: parsedArgs };
        } catch {
          args = { input: raw };
          issue(line, "invalid_tool_arguments");
        }
      } else args = object(raw);
      const name =
        type === "web_search_call"
          ? "web_search_call"
          : text(payload.namespace)
            ? `${text(payload.namespace)}.${text(payload.name)}`
            : text(payload.name);
      if (!name) issue(line, "missing_tool_name");
      step.tool_calls ??= [];
      step.tool_calls.push({
        tool_call_id: id,
        function_name: name || "unknown",
        arguments: args,
        extra: {
          orbit: {
            native_type: type,
            native_line: line,
            ...(raw === undefined ? {} : { raw_arguments: raw }),
          },
        },
      });
      calls.set(id, step);
      if (type === "web_search_call" && payload.status === "completed") {
        step.observation ??= { results: [] };
        step.observation.results.push({
          source_call_id: id,
          content: "",
          extra: { orbit: { status: payload.status, native: payload } },
        });
        answered.add(id);
      }
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      const id = text(payload.call_id);
      const step = calls.get(id);
      if (!step || answered.has(id)) {
        issue(line, step ? "duplicate_tool_result" : "orphan_tool_result", event);
        continue;
      }
      step.observation ??= { results: [] };
      step.observation.results.push({
        source_call_id: id,
        content: content(payload.output, line),
        extra: {
          orbit: { native_line: line, ...(event.timestamp ? { timestamp: event.timestamp } : {}) },
        },
      });
      answered.add(id);
    } else if (type === "compaction") {
      // Compaction payloads can be encrypted; only the explicit compacted summary is exported.
      metadata.push({ line, event: { type: event.type, payload: { type, opaque: true } } });
    } else if (type === "additional_tools" || type === "configuration_update") {
      metadata.push({ line, event });
    } else {
      issue(line, `response_item/${type || "unknown"}`, event);
    }
  }

  for (const [id, step] of calls) {
    if (!answered.has(id))
      issue(Number(object(object(step.extra?.orbit).native).line), "missing_tool_result", {
        call_id: id,
      });
  }
  if (!steps.length) throw new Error("Codex rollout contains no trajectory steps");
  const withMetrics = steps.flatMap((step) => (step.metrics ? [step.metrics] : []));
  const missingUsage = steps.filter((step) => step.source === "agent" && !step.metrics);
  if (withMetrics.length && missingUsage.length) {
    for (const step of missingUsage)
      issue(Number(object(object(step.extra?.orbit).native).line), "missing_usage");
  }
  const final: AtifFinalMetrics = { total_steps: steps.length };
  for (const [field, target] of [
    ["prompt_tokens", "total_prompt_tokens"],
    ["completion_tokens", "total_completion_tokens"],
    ["cached_tokens", "total_cached_tokens"],
  ] as const) {
    if (
      !uncertainPrefix &&
      !missingUsage.length &&
      withMetrics.length &&
      withMetrics.every((metrics) => metrics[field] !== undefined && metrics[field] !== null)
    ) {
      final[target] = withMetrics.reduce((sum, metrics) => sum + (metrics[field] ?? 0), 0);
    }
  }
  const nativeUsages = withMetrics.map((metrics) =>
    object(object(metrics.extra?.orbit).native_usage),
  );
  final.extra = {
    orbit: {
      ...(reportedTotal ? { reported_total: reportedTotal } : {}),
      ...(!uncertainPrefix &&
      !missingUsage.length &&
      nativeUsages.length &&
      nativeUsages.every((usage) => count(usage.reasoning_output_tokens) !== undefined)
        ? {
            reasoning_output_tokens: nativeUsages.reduce(
              (sum, usage) => sum + (count(usage.reasoning_output_tokens) ?? 0),
              0,
            ),
          }
        : {}),
      measured_calls: withMetrics.length,
      ...(!uncertainPrefix && !missingUsage.length ? { calls: withMetrics.length } : {}),
    },
  };
  const trajectory = AtifTrajectory.parse({
    schema_version: "ATIF-v1.7",
    session_id: sessionId,
    agent: {
      name: "codex",
      version: [...versions][0] ?? "unknown",
      ...(model ? { model_name: model } : {}),
    },
    steps,
    final_metrics: final,
    extra: {
      orbit: {
        version: 1,
        ...(options.run ? { run: options.run } : {}),
        importer: { name: "codex-rollout", version: 1 },
        sources: [
          {
            path: options.sourcePath ?? "agent/codex/rollout.jsonl",
            sha256: hash,
            bytes: Buffer.byteLength(input),
          },
        ],
        completeness: unsupported.length ? "truncated" : "agent-only",
        cli_versions: [...versions],
        ...(versions.size ? { cli_version: [...versions][0] } : {}),
        ...(unsupported.length ? { unknown_events: unsupported } : {}),
        ...(metadata.length ? { metadata: { native_events: nativeMetadata(metadata) } } : {}),
      },
    },
  });
  return { trajectory, media };
}
