import { z } from "zod";
import { MetricSpec, MetricStat } from "./bench.ts";
import { GateCheck, GateReportRef, GateVerdict } from "./gate.ts";

const Bundle = z.string().regex(/^[a-f0-9]{64}$/, "bundle must be a full SHA-256 digest");
export const TransferQuery = z
  .strictObject({ parentBundle: Bundle.optional(), childBundle: Bundle.optional() })
  .refine((q) => Boolean(q.parentBundle) === Boolean(q.childBundle), {
    message: "parentBundle and childBundle must be supplied together",
  })
  .refine((q) => !q.parentBundle || q.parentBundle !== q.childBundle, {
    message: "parentBundle and childBundle must differ",
  });
export type TransferQuery = z.infer<typeof TransferQuery>;

export const TransferCondition = z.strictObject({
  digest: z.string(),
  benchmark: z.string(),
  version: z.string().nullable(),
  variant: z.string().nullable(),
  sourceCommit: z.string().nullable(),
  agent: z.string(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  taskSet: z.string().nullable(),
  tasks: z.number().int().nonnegative(),
  metric: MetricSpec.nullable(),
  budgets: z.array(
    z.strictObject({
      tasks: z.number().int().positive(),
      cpus: z.number().nullable(),
      memGB: z.number().nullable(),
      gpus: z.number().nullable(),
      gpuMemGB: z.number().nullable(),
      timeoutMin: z.number().nullable(),
    }),
  ),
});
export type TransferCondition = z.infer<typeof TransferCondition>;
export const TransferColumn = z.strictObject({
  id: z.string(),
  benchmark: z.string(),
  agent: z.string().nullable(),
  role: z.enum(["gate", "guard", "final"]),
  metric: z.string(),
  taskFile: z.string(),
  parent: TransferCondition.nullable(),
  child: TransferCondition.nullable(),
});
export type TransferColumn = z.infer<typeof TransferColumn>;
export const TransferAssessment = z.strictObject({
  record: z.string(),
  createdAt: z.string().datetime(),
  set: z.string(),
  policyDigest: z.string(),
  parentRevision: z.string(),
  childRevision: z.string(),
  parent: GateReportRef.nullable(),
  child: GateReportRef.nullable(),
  status: z.enum(["pass", "fail", "insufficient", "missing", "incompatible"]),
  decision: GateVerdict.shape.decision,
  level: GateVerdict.shape.level,
  checks: z.array(GateCheck),
  /** Raw child minus parent, regardless of metric direction. Display CI is descriptive. */
  delta: MetricStat.nullable(),
  eligible: z.number().int().nonnegative().nullable(),
  total: z.number().int().nonnegative().nullable(),
  excluded: z.number().int().nonnegative(),
  alpha: GateVerdict.shape.alpha,
});
export type TransferAssessment = z.infer<typeof TransferAssessment>;
export const TransferRow = z.strictObject({
  id: z.string(),
  parentBundle: Bundle,
  childBundle: Bundle,
  cells: z.array(
    z.strictObject({ column: z.string(), assessments: z.array(TransferAssessment).min(1) }),
  ),
});
export type TransferRow = z.infer<typeof TransferRow>;
export const TransferMatrix = z.strictObject({
  columns: z.array(TransferColumn),
  rows: z.array(TransferRow),
  omitted: z.array(
    z.strictObject({
      record: z.string(),
      reason: z.enum(["calibration", "unresolved-bundles", "unchanged-bundle"]),
    }),
  ),
});
export type TransferMatrix = z.infer<typeof TransferMatrix>;
