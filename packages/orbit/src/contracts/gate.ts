import { z } from "zod";
import { BenchJob, BenchReport, MetricStat } from "./bench.ts";

const Revision = z.string().regex(/^[a-f0-9]{12}$/);
const Tasks = z.strictObject({
  file: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const Dataset = z.strictObject({ benchmark: z.string().min(1), tasks: Tasks });
export const GatePolicy = z.strictObject({
  version: z.literal(1),
  alpha: z.number().min(1e-12).max(0.25).default(0.05),
  spending: z.literal("inverse-square").default("inverse-square"),
  min_paired_tasks: z.number().int().min(2).default(30),
  min_coverage: z.number().positive().max(1).default(0.9),
  max_invalid_increase: z.number().min(0).max(1).default(0.05),
  change: z.literal("bundle-only").default("bundle-only"),
  metric: z.string().min(1).default("score"),
  pass_value: z.number().optional(),
  gate: Dataset,
  guard: z.array(Dataset.extend({ margin: z.number().nonnegative().default(5) })).default([]),
  final: z
    .array(
      Dataset.extend({
        agents: z
          .array(z.string().min(1))
          .min(1)
          .refine((v) => new Set(v).size === v.length),
      }),
    )
    .default([]),
  cost: z
    .strictObject({
      max_wall_ratio: z.number().positive().default(1.5),
      max_token_ratio: z.number().positive().default(1.5),
    })
    .default({ max_wall_ratio: 1.5, max_token_ratio: 1.5 }),
});
export type GatePolicy = z.infer<typeof GatePolicy>;
export type GatePolicyInput = z.input<typeof GatePolicy>;
export const GateReportRef = z.strictObject({
  job: z.string(),
  revision: z.number().int().positive(),
  method: z.string(),
});
export type GateReportRef = z.infer<typeof GateReportRef>;
export const GateEvidence = z.strictObject({
  jobs: z.array(BenchJob),
  reports: z.array(BenchReport),
  taskSets: z.array(z.strictObject({ file: z.string(), content: z.string().max(8 * 1024 * 1024) })),
  selections: z.array(
    z.strictObject({ set: z.string(), parent: GateReportRef, child: GateReportRef }),
  ),
});
export type GateEvidence = z.infer<typeof GateEvidence>;
export const GateCheck = z.strictObject({
  set: z.string(),
  kind: z.enum([
    "lineage",
    "tasks",
    "reports",
    "conditions",
    "coverage",
    "validity",
    "improvement",
    "non-inferiority",
    "wall-cost",
    "token-cost",
  ]),
  status: z.enum(["pass", "fail", "insufficient", "not_checked"]),
  required: z.boolean(),
  prerequisite: z.boolean(),
  reason: z.string(),
  parent: z.number().nullable().optional(),
  child: z.number().nullable().optional(),
  limit: z.number().optional(),
  diff: MetricStat.nullable().optional(),
  lower: z.number().nullable().optional(),
  upper: z.number().nullable().optional(),
  mcnemar: z
    .strictObject({
      gains: z.number().int(),
      losses: z.number().int(),
      greater: z.number().nullable(),
      less: z.number().nullable(),
      twoSided: z.number().nullable(),
    })
    .optional(),
});
export type GateCheck = z.infer<typeof GateCheck>;
export const GateVerdict = z.strictObject({
  decision: z.enum(["accept", "reject", "insufficient"]),
  level: z.enum(["in-domain", "cross-domain", "transferable"]).nullable(),
  checks: z.array(GateCheck),
  regressions: z.array(
    z.strictObject({
      set: z.string(),
      benchmark: z.string(),
      task: z.string(),
      parent: z.number(),
      child: z.number(),
    }),
  ),
  alpha: z.strictObject({ round: z.number().int().positive(), level: z.number().nonnegative() }),
  inputs: z.strictObject({
    parent: Revision,
    child: Revision,
    policyDigest: z.string(),
    reports: z.array(GateReportRef),
    taskSets: z.array(
      z.strictObject({
        set: z.string(),
        benchmark: z.string(),
        sha256: z.string(),
        taskSet: z.string(),
        total: z.number().int(),
        eligible: z.number().int(),
        excluded: z.array(
          z.strictObject({ task: z.string(), trial: z.string(), revision: Revision }),
        ),
      }),
    ),
    priorChildren: z.array(Revision),
  }),
});
export type GateVerdict = z.infer<typeof GateVerdict>;
