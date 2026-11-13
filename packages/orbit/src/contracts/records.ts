import { z } from "zod";

export const RunEvent = z.object({
  seq: z.number().int(),
  runId: z.string(),
  at: z.string(),
  kind: z.string(),
  message: z.string(),
});
export type RunEvent = z.infer<typeof RunEvent>;

export const RunEvents = z.object({ events: z.array(RunEvent) });

/** A chunk of the combined stdout/stderr log. Offsets are byte offsets in the log file. */
export const LogChunk = z.object({
  offset: z.number().int(),
  /** May equal offset below size while a running log's trailing secret bytes are withheld. */
  next: z.number().int(),
  size: z.number().int(),
  text: z.string(),
  /** True when the run is terminal and `next` reached the end of the log. */
  eof: z.boolean(),
});
export type LogChunk = z.infer<typeof LogChunk>;

export const MetricSeries = z.object({
  key: z.string(),
  /** [step, value] pairs; step falls back to the line number when missing. */
  points: z.array(z.tuple([z.number(), z.number()])),
});
export const Metrics = z.object({
  series: z.array(MetricSeries),
  /** Last value of every numeric key, for tables. */
  summary: z.record(z.string(), z.number()),
  invalidLines: z.number().int(),
});
export type Metrics = z.infer<typeof Metrics>;

export const Artifact = z.object({ path: z.string(), bytes: z.number().int(), mtime: z.string() });
export const Artifacts = z.object({ files: z.array(Artifact), truncated: z.boolean() });
export type Artifacts = z.infer<typeof Artifacts>;

export const CodeDiff = z.object({ patch: z.string(), truncated: z.boolean() });

export const SessionMessage = z.object({
  /** Stable ATIF identity; legacy transcripts can omit it. */
  stepId: z.number().int().positive().optional(),
  at: z.string().nullable(),
  role: z.enum(["user", "assistant", "tool", "system"]),
  kind: z.enum(["text", "thinking", "tool_call", "tool_result"]),
  /** Tool name for tool_call/tool_result. */
  name: z.string().optional(),
  text: z.string(),
  truncated: z.boolean().optional(),
});
export type SessionMessage = z.infer<typeof SessionMessage>;
export const SessionTranscript = z.object({
  harness: z.string(),
  sessionId: z.string(),
  file: z.string().nullable(),
  messages: z.array(SessionMessage),
  completeness: z.enum(["complete", "truncated", "agent-only", "environment-only"]).optional(),
});
export type SessionTranscript = z.infer<typeof SessionTranscript>;
/**
 * The sessions of a run: `submitter` is the host Agent session that submitted it (`spec.agent`),
 * `agent` the session of an Agent that ran inside it (kept in the run directory).
 */
export const RunSessions = z.object({
  submitter: SessionTranscript.nullable(),
  /** Why the submitter's transcript is missing although the run is linked to one. */
  submitterError: z.string().nullable(),
  agent: SessionTranscript.nullable(),
  agentError: z.string().nullable().optional(),
});
export type RunSessions = z.infer<typeof RunSessions>;
