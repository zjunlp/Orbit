import { z } from "zod";

export const ATIF_WRITE_VERSION = "ATIF-v1.7" as const;
export const AtifVersion = z.enum(["ATIF-v1.5", "ATIF-v1.6", "ATIF-v1.7", "ATIF-v1.8"]);
export type AtifVersion = z.infer<typeof AtifVersion>;

const Extra = z.record(z.string(), z.unknown());
const Count = z.number().int().nonnegative();
const OptionalString = z.string().nullish();

export const AtifOrbit = z.strictObject({
  version: z.literal(1),
  run: z.string().optional(),
  trial: z.string().optional(),
  job: z.string().optional(),
  benchmark: z.strictObject({ id: z.string(), version: z.string().optional() }).optional(),
  task: z.string().optional(),
  method: z.strictObject({ name: z.string(), revision: z.string() }).optional(),
  importer: z.strictObject({ name: z.string().min(1), version: Count.min(1) }),
  sources: z.array(
    z.strictObject({ path: z.string(), sha256: z.string().regex(/^[a-f\d]{64}$/i), bytes: Count }),
  ),
  completeness: z.enum(["complete", "truncated", "agent-only", "environment-only"]),
  cli_version: z.string().optional(),
  cli_versions: z.array(z.string()).optional(),
  metadata: Extra.optional(),
  warnings: z.array(z.string()).optional(),
  unknown_events: z.array(z.unknown()).optional(),
});
export type AtifOrbit = z.infer<typeof AtifOrbit>;

export const AtifStepOrbit = z.strictObject({
  metadata: Extra.optional(),
  native: z.strictObject({ id: z.string().optional(), line: Count.min(1).optional() }).optional(),
  reasoning: z.enum(["raw", "summary", "opaque", "none"]).optional(),
  env: z
    .strictObject({ kind: z.enum(["gui", "episode", "conversation"]), ref: z.string() })
    .optional(),
  checkpoint: z.strictObject({ id: z.string(), level: z.enum(["step", "final"]) }).optional(),
});
export type AtifStepOrbit = z.infer<typeof AtifStepOrbit>;

const RootExtra = z.object({ orbit: AtifOrbit.optional() }).catchall(z.unknown());
const StepExtra = z.object({ orbit: AtifStepOrbit.optional() }).catchall(z.unknown());
const ImageSource = z.strictObject({
  media_type: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
  path: z.string(),
});
const audioAliases: Record<string, string> = {
  "audio/mp3": "audio/mpeg",
  "audio/mpga": "audio/mpeg",
  "audio/x-mpeg": "audio/mpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-aac": "audio/aac",
  "audio/x-flac": "audio/flac",
  "audio/x-aiff": "audio/aiff",
};
const AudioSource = z.strictObject({
  media_type: z
    .string()
    .transform((value) => {
      const normalized = value.trim().toLowerCase();
      return audioAliases[normalized] ?? normalized;
    })
    .pipe(
      z.enum([
        "audio/wav",
        "audio/mpeg",
        "audio/mp4",
        "audio/aac",
        "audio/ogg",
        "audio/flac",
        "audio/webm",
        "audio/aiff",
      ]),
    ),
  path: z.string(),
  duration_sec: z.number().nonnegative().nullish(),
});
export const AtifContentPart = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string(), source: z.null().optional() }),
  z.strictObject({ type: z.literal("image"), source: ImageSource, text: z.null().optional() }),
  z.strictObject({ type: z.literal("audio"), source: AudioSource, text: z.null().optional() }),
]);
export type AtifContentPart = z.infer<typeof AtifContentPart>;
const Content = z.union([z.string(), z.array(AtifContentPart)]);

export const AtifAgent = z.strictObject({
  name: z.string(),
  version: z.string(),
  model_name: OptionalString,
  tool_definitions: z.array(Extra).nullish(),
  extra: Extra.nullish(),
});
export type AtifAgent = z.infer<typeof AtifAgent>;

export const AtifMetrics = z.strictObject({
  prompt_tokens: Count.nullish(),
  completion_tokens: Count.nullish(),
  cached_tokens: Count.nullish(),
  cost_usd: z.number().nonnegative().nullish(),
  prompt_token_ids: z.array(Count).nullish(),
  completion_token_ids: z.array(Count).nullish(),
  logprobs: z.array(z.number()).nullish(),
  extra: Extra.nullish(),
});
export type AtifMetrics = z.infer<typeof AtifMetrics>;

export const AtifFinalMetrics = z.strictObject({
  total_prompt_tokens: Count.nullish(),
  total_completion_tokens: Count.nullish(),
  total_cached_tokens: Count.nullish(),
  total_cost_usd: z.number().nonnegative().nullish(),
  total_steps: Count.nullish(),
  extra: Extra.nullish(),
});
export type AtifFinalMetrics = z.infer<typeof AtifFinalMetrics>;

export const AtifToolCall = z.strictObject({
  tool_call_id: z.string(),
  function_name: z.string(),
  arguments: Extra,
  extra: Extra.nullish(),
});
export type AtifToolCall = z.infer<typeof AtifToolCall>;

export const AtifSubagentRef = z.strictObject({
  trajectory_id: OptionalString,
  session_id: OptionalString,
  trajectory_path: OptionalString,
  extra: Extra.nullish(),
});
export type AtifSubagentRef = z.infer<typeof AtifSubagentRef>;

export const AtifObservationResult = z.strictObject({
  source_call_id: OptionalString,
  content: Content.nullish(),
  subagent_trajectory_ref: z.array(AtifSubagentRef).nullish(),
  extra: Extra.nullish(),
});
export type AtifObservationResult = z.infer<typeof AtifObservationResult>;

export const AtifStep = z
  .strictObject({
    step_id: Count.min(1),
    timestamp: z.iso.datetime({ offset: true, local: true }).nullish(),
    source: z.enum(["system", "user", "agent"]),
    model_name: OptionalString,
    reasoning_effort: z.union([z.string(), z.number()]).nullish(),
    message: Content,
    reasoning_content: OptionalString,
    tool_calls: z.array(AtifToolCall).nullish(),
    observation: z.strictObject({ results: z.array(AtifObservationResult) }).nullish(),
    metrics: AtifMetrics.nullish(),
    is_copied_context: z.boolean().nullish(),
    llm_call_count: Count.nullish(),
    extra: StepExtra.nullish(),
  })
  .superRefine((step, ctx) => {
    if (step.source !== "agent") {
      for (const field of [
        "model_name",
        "reasoning_effort",
        "reasoning_content",
        "tool_calls",
        "metrics",
      ] as const) {
        if (step[field] != null)
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: "Only agent steps may contain this field",
          });
      }
    }
    if (step.source === "agent" && step.llm_call_count === 0) {
      for (const field of ["metrics", "reasoning_content"] as const) {
        if (step[field] != null)
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: "Deterministic steps cannot contain LLM metrics or reasoning",
          });
      }
    }
    const calls = new Set<string>();
    for (const [index, call] of (step.tool_calls ?? []).entries()) {
      if (calls.has(call.tool_call_id))
        ctx.addIssue({
          code: "custom",
          path: ["tool_calls", index, "tool_call_id"],
          message: "Duplicate tool call ID within step",
        });
      calls.add(call.tool_call_id);
    }
    for (const [index, result] of (step.observation?.results ?? []).entries()) {
      if (result.source_call_id != null && !calls.has(result.source_call_id))
        ctx.addIssue({
          code: "custom",
          path: ["observation", "results", index, "source_call_id"],
          message: "Observation must reference a tool call in the same step",
        });
    }
  });
export type AtifStep = z.infer<typeof AtifStep>;

export interface AtifTrajectory {
  schema_version: AtifVersion;
  session_id?: string | null;
  trajectory_id?: string | null;
  agent: AtifAgent;
  steps: AtifStep[];
  notes?: string | null;
  final_metrics?: AtifFinalMetrics | null;
  continued_trajectory_ref?: string | null;
  extra?: z.infer<typeof RootExtra> | null;
  subagent_trajectories?: AtifTrajectory[] | null;
}

export const AtifTrajectory: z.ZodType<AtifTrajectory> = z.lazy(() =>
  z
    .strictObject({
      schema_version: AtifVersion,
      session_id: OptionalString,
      trajectory_id: OptionalString,
      agent: AtifAgent,
      steps: z.array(AtifStep).min(1),
      notes: OptionalString,
      final_metrics: AtifFinalMetrics.nullish(),
      continued_trajectory_ref: OptionalString,
      extra: RootExtra.nullish(),
      subagent_trajectories: z.array(AtifTrajectory).nullish(),
    })
    .superRefine((trajectory, ctx) => {
      const legacy =
        trajectory.schema_version === "ATIF-v1.5" || trajectory.schema_version === "ATIF-v1.6";
      if (legacy && trajectory.session_id == null)
        ctx.addIssue({
          code: "custom",
          path: ["session_id"],
          message: "ATIF before v1.7 requires session_id",
        });
      const embedded = new Set<string>();
      for (const [index, child] of (trajectory.subagent_trajectories ?? []).entries()) {
        if (child.trajectory_id == null || embedded.has(child.trajectory_id))
          ctx.addIssue({
            code: "custom",
            path: ["subagent_trajectories", index, "trajectory_id"],
            message: "Embedded trajectories require a unique trajectory_id",
          });
        if (child.trajectory_id != null) embedded.add(child.trajectory_id);
      }
      for (const [index, step] of trajectory.steps.entries()) {
        if (step.step_id !== index + 1)
          ctx.addIssue({
            code: "custom",
            path: ["steps", index, "step_id"],
            message: "Step IDs must be sequential starting at 1",
          });
        const checkContent = (content: unknown, path: (string | number)[]) => {
          if (!Array.isArray(content)) return;
          if (trajectory.schema_version === "ATIF-v1.5")
            ctx.addIssue({
              code: "custom",
              path,
              message: "Multimodal content requires ATIF v1.6 or later",
            });
          if (
            trajectory.schema_version !== "ATIF-v1.8" &&
            content.some((part: AtifContentPart) => part.type === "audio")
          )
            ctx.addIssue({ code: "custom", path, message: "Audio content requires ATIF v1.8" });
        };
        checkContent(step.message, ["steps", index, "message"]);
        for (const [resultIndex, result] of (step.observation?.results ?? []).entries()) {
          const path = ["steps", index, "observation", "results", resultIndex];
          checkContent(result.content, [...path, "content"]);
          for (const [refIndex, ref] of (result.subagent_trajectory_ref ?? []).entries()) {
            if (
              legacy
                ? ref.session_id == null
                : ref.trajectory_id == null && ref.trajectory_path == null
            )
              ctx.addIssue({
                code: "custom",
                path: [...path, "subagent_trajectory_ref", refIndex],
                message: legacy
                  ? "Legacy subagent references require session_id"
                  : "Subagent references require trajectory_id or trajectory_path",
              });
            if (
              !legacy &&
              ref.trajectory_id != null &&
              ref.trajectory_path == null &&
              !embedded.has(ref.trajectory_id)
            ) {
              ctx.addIssue({
                code: "custom",
                path: [...path, "subagent_trajectory_ref", refIndex, "trajectory_id"],
                message: "Embedded reference must match a subagent trajectory_id",
              });
            }
          }
        }
      }
    }),
);
