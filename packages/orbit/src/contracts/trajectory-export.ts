import { z } from "zod";
import { AtifContentPart, AtifOrbit } from "./atif.ts";
import { Outcome } from "./bench.ts";
import { SampleIdentity } from "./embodied.ts";
import { RunState, RunTokens } from "./runs.ts";

const Names = z.array(z.string().min(1).max(1000)).max(10_000).default([]);
const ExportOptions = z.strictObject({
  runs: Names,
  trials: Names,
  jobs: Names,
  tasks: Names,
  methods: Names,
  validOnly: z.boolean().default(false),
  outcome: z.enum(["pass", "fail"]).optional(),
  format: z.enum(["atif", "chat-jsonl"]).default("atif"),
  reasoning: z.enum(["raw", "summary", "none"]).default("summary"),
  out: z.string().min(1).max(4096),
});
export const TrajectoryExportRequest = ExportOptions.refine(
  (r) => [r.runs, r.trials, r.jobs].filter((ids) => ids.length > 0).length === 1,
  {
    message: "select exactly one of runs, trials or jobs",
  },
);
export type TrajectoryExportRequest = z.infer<typeof TrajectoryExportRequest>;
export type TrajectoryExportInput = z.input<typeof TrajectoryExportRequest>;

export const ExportTrialContext = z.strictObject({
  trial: z.string(),
  job: z.string(),
  benchmark: z.string(),
  task: z.string(),
  method: z.string(),
  revision: z.string().nullable(),
  revisionApproximate: z.boolean().nullable(),
  sample: SampleIdentity,
  phase: z.enum(["solve", "verify"]),
  priorAttempt: z.boolean(),
  outcome: Outcome.pick({
    execution: true,
    evaluation: true,
    score: true,
    maxScore: true,
    cleanup: true,
  }).nullable(),
});
export type ExportTrialContext = z.infer<typeof ExportTrialContext>;

export const TrajectoryExportManifest = z.strictObject({
  version: z.literal(1),
  exporter: z.strictObject({ name: z.literal("orbit"), version: z.string() }),
  createdAt: z.string(),
  format: z.enum(["atif", "chat-jsonl"]),
  reasoning: z.enum(["raw", "summary", "none"]),
  filters: ExportOptions.omit({ out: true }),
  licenseNotice: z.string(),
  entries: z.array(
    z.strictObject({
      run: z.string(),
      path: z.string(),
      execution: RunState,
      cleanup: z.enum(["pending", "done", "failed"]),
      exitCode: z.number().nullable(),
      contexts: z.array(ExportTrialContext),
      tokens: RunTokens.nullable(),
      completeness: AtifOrbit.shape.completeness.nullable(),
      steps: z.number().int().nonnegative(),
      trajectories: z.number().int().positive(),
    }),
  ),
  files: z.array(
    z.strictObject({
      path: z.string(),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
});
export type TrajectoryExportManifest = z.infer<typeof TrajectoryExportManifest>;
export const TrajectoryExportResult = z.strictObject({
  out: z.string(),
  manifest: z.string(),
  runs: z.number().int().positive(),
  files: z.number().int().positive(),
});
export type TrajectoryExportResult = z.infer<typeof TrajectoryExportResult>;

export const ChatTrajectory = z.strictObject({
  run: z.string(),
  trajectory_id: z.string().nullable(),
  parent_trajectory_id: z.string().nullable(),
  tools: z.array(z.record(z.string(), z.unknown())),
  messages: z.array(
    z.strictObject({
      step_id: z.number().int().positive(),
      role: z.enum(["system", "user", "assistant", "tool"]),
      content: z.union([z.string(), z.array(AtifContentPart)]),
      reasoning_content: z.string().optional(),
      tool_calls: z
        .array(
          z.strictObject({
            id: z.string(),
            type: z.literal("function"),
            function: z.strictObject({ name: z.string(), arguments: z.string() }),
          }),
        )
        .optional(),
      tool_call_id: z.string().optional(),
      observation: z.boolean().optional(),
    }),
  ),
});
export type ChatTrajectory = z.infer<typeof ChatTrajectory>;
