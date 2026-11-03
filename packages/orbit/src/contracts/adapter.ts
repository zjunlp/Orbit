import { z } from "zod";
import {
  BenchCapabilities,
  BenchTask,
  Episode,
  FailureKind,
  Method,
  MetricSpec,
  OfficialRule,
  ResourceOverride,
  Review,
} from "./bench.ts";
import { Run } from "./runs.ts";

const MetricSpecs = z
  .array(MetricSpec)
  .max(20)
  .refine((ms) => new Set(ms.map((m) => m.name)).size === ms.length, "metric names must be unique")
  .refine((ms) => ms.filter((m) => m.primary).length <= 1, "at most one primary metric");

/** Per-trial metric values; non-finite values are dropped. */
const MetricValues = z
  .record(z.string(), z.number().nullable())
  .transform((r) =>
    Object.fromEntries(
      Object.entries(r).filter((e): e is [string, number] => Number.isFinite(e[1])),
    ),
  );

export const ADAPTER_PROTOCOL = 1;
export const AdapterOp = z.enum(["tasks", "solve", "verify", "score"]);
export type AdapterOp = z.infer<typeof AdapterOp>;

/** RunSpec fields Orbit sets itself; an adapter's run spec may not contain them. */
export const ORBIT_OWNED_SPEC_FIELDS = [
  "name",
  "group",
  "params",
  "project",
  "snapshot",
  "auth",
  "agentBundle",
  "agent",
  "parentId",
  "priority",
  "passEnv",
] as const;

/**
 * A run as an adapter describes it: RunSpec fields (validated as a RunSpec once Orbit has added its
 * own) with either `command`, or `agentTask` for Agent methods, which Orbit turns into the method's
 * Agent CLI command with its auth and bundle.
 */
export const AdapterRunSpec = z
  .looseObject({
    command: z.array(z.string()).min(1).optional(),
    agentTask: z.object({ instruction: z.string().min(1) }).optional(),
  })
  .refine((s) => !ORBIT_OWNED_SPEC_FIELDS.some((k) => k in s), {
    message: `adapter run specs may not set ${ORBIT_OWNED_SPEC_FIELDS.join(", ")}`,
  })
  .refine((s) => Boolean(s.command) !== Boolean(s.agentTask), {
    message: "an adapter run spec needs exactly one of command or agentTask",
  });
export type AdapterRunSpec = z.infer<typeof AdapterRunSpec>;

export const AdapterRunRef = z.object({
  run: Run,
  /** Host path of the run's output directory (`$ORBIT_OUTPUT`). */
  output: z.string(),
});
export type AdapterRunRef = z.infer<typeof AdapterRunRef>;

/** Request on the adapter's stdin; `trial` from `solve` on, `solve` from `verify`, `verify` for `score`. */
export const AdapterRequest = z.object({
  protocol: z.literal(ADAPTER_PROTOCOL),
  op: AdapterOp,
  benchmark: z.object({
    name: z.string(),
    path: z.string(),
    config: z.record(z.string(), z.string()),
  }),
  trial: z
    .object({
      id: z.string(),
      task: z.string(),
      method: Method,
      seed: z.number().int(),
      /** Job options (`orbit bench run --option key=value`). */
      options: z.record(z.string(), z.string()),
      timeoutMin: z.number().positive().optional(),
      /** Resolved solve overrides, also needed by native runners that launch containers. */
      resources: ResourceOverride.optional(),
      /** Private per-trial host directory for files mounted into the runs; removed with the trial. */
      staging: z.string(),
      /** The method's auth profile uses the host network (for runners that start containers). */
      hostNetwork: z.boolean(),
    })
    .optional(),
  solve: AdapterRunRef.optional(),
  verify: AdapterRunRef.optional(),
});
export type AdapterRequest = z.infer<typeof AdapterRequest>;

export const AdapterTasksResponse = z.object({
  tasks: z.array(BenchTask),
  metrics: MetricSpecs.default([]),
  capabilities: BenchCapabilities.optional(),
  /** The benchmark's own aggregation rule, reported next to Orbit's valid-only view. */
  official: OfficialRule.optional(),
});
export type AdapterTasksResponse = z.infer<typeof AdapterTasksResponse>;
export const AdapterSpecResponse = z.object({
  spec: AdapterRunSpec,
  /** Recorded on the trial (e.g. artifacts the solve run did not produce). */
  issues: z.array(z.string()).default([]),
});
export type AdapterSpecResponse = z.input<typeof AdapterSpecResponse>;

/** `score`: `invalid` when the verifier could not produce a trustworthy score. */
export const ScoreResult = z.object({
  score: z.number().nullable(),
  maxScore: z.number().positive().default(1),
  invalid: z.boolean().default(false),
  issues: z.array(z.string()).default([]),
  review: Review.optional(),
  /** Values of declared metrics (other than `score`); undeclared names are kept but not shown. */
  metrics: MetricValues.optional(),
  /** Why the score is not trustworthy (with `invalid`), from the closed set. */
  failure: FailureKind.optional(),
  /** How an interactive episode ended. */
  episode: Episode.optional(),
});
export type ScoreResult = z.infer<typeof ScoreResult>;
