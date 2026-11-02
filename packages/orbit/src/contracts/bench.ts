import { z } from "zod";
import { EnvName, ProfileName } from "./common.ts";
import { Folder } from "./folders.ts";
import { CheckpointPolicy } from "./runs.ts";

/** Adapters shipped with Orbit (`orbit __adapter <name>`). */
export const BUILTIN_ADAPTERS = ["harbor", "asi"] as const;

/** A registered benchmark checkout. */
export const BenchmarkInput = z.object({
  name: ProfileName,
  /**
   * A built-in adapter (`harbor`: task.toml task directories; `asi`: ASI-Bench with its native
   * runner) or the absolute path of an executable speaking the adapter protocol (design §7).
   */
  adapter: z
    .string()
    .refine(
      (a) => (BUILTIN_ADAPTERS as readonly string[]).includes(a) || a.startsWith("/"),
      `adapter must be ${BUILTIN_ADAPTERS.join(" or ")}, or the absolute path of an executable`,
    ),
  /** Absolute path of the benchmark checkout (the adapter's working directory). */
  path: z.string().refine((p) => p.startsWith("/"), "path must be absolute"),
  /** Adapter settings, e.g. asi `python` and `instances`. Non-secret. */
  config: z.record(z.string(), z.string()).default({}),
  /** Extra non-secret variables for every run of this benchmark. */
  env: z.record(EnvName, z.string()).default({}),
  /** Variables copied from the daemon environment into verify runs (judge API keys); never stored. */
  passEnv: z.array(EnvName).default([]),
  /** Absolute path of a resources file (`BenchResources`) overriding the solve resources per task. */
  resources: z
    .string()
    .refine((p) => p.startsWith("/"), "resources must be an absolute path")
    .optional(),
});
export type BenchmarkInput = z.input<typeof BenchmarkInput>;
export const Benchmark = BenchmarkInput.extend({ createdAt: z.string(), updatedAt: z.string() });
export type Benchmark = z.infer<typeof Benchmark>;

export const BenchTask = z.object({
  id: z.string(),
  title: z.string().nullable(),
  /** Unsupported tasks are listed but never run (e.g. docker-compose environments). */
  supported: z.boolean(),
  reason: z.string().nullable(),
  tags: z.record(z.string(), z.string()).default({}),
});
export type BenchTask = z.infer<typeof BenchTask>;

/**
 * A metric an adapter declares (`tasks` reply) and reports per trial (`score` reply `metrics`).
 * Valid trials average per task, then over tasks (see `contracts/metrics.ts`). `score`, the score
 * as a percent of its maximum, always exists; declaring it changes only how it is labelled.
 */
export const MetricSpec = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-zA-Z0-9_]{0,39}$/, "metric names are camelCase or snake_case identifiers"),
  label: z.string().min(1).max(40),
  description: z.string().max(200).optional(),
  unit: z.string().max(8).optional(),
  range: z
    .tuple([z.number(), z.number()])
    .refine(([lo, hi]) => hi > lo, "range must be [low, high]")
    .optional(),
  higherIsBetter: z.boolean().default(true),
  primary: z.boolean().default(false),
  reference: z.number().optional(),
});
export type MetricSpec = z.infer<typeof MetricSpec>;
export type MetricSpecInput = z.input<typeof MetricSpec>;

export const METHOD_AGENTS = ["codex", "claude-code", "external", "oracle", "empty"] as const;
export type MethodAgent = (typeof METHOD_AGENTS)[number];

export const BenchCapabilities = z.object({
  kind: z.enum(["browser", "desktop", "mobile", "other"]),
  methods: z.array(z.enum(METHOD_AGENTS)).min(1),
  conditions: z.record(z.string().max(80), z.string().max(2000)),
  scoreKind: z.enum(["binary", "scalar"]),
  rescore: z.enum(["evidence", "score", "none"]),
});
export type BenchCapabilities = z.infer<typeof BenchCapabilities>;

/**
 * An AgentProfile: harness (with the host CLI version recorded per run) + model + auth + method
 * bundle, or an adapter-owned external policy. `oracle` and `empty` calibrate an adapter.
 */
export const Method = z
  .object({
    name: ProfileName,
    agent: z.enum(METHOD_AGENTS),
    auth: ProfileName.optional(),
    model: z.string().optional(),
    /** Reasoning effort, e.g. `high`. */
    effort: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/, "effort must be a plain word, e.g. high")
      .optional(),
    /** Method bundle directory (AGENTS.md / CLAUDE.md, skills) copied into the Agent home. */
    bundle: z.string().optional(),
    /** External policy entrypoint, interpreted by its benchmark adapter. */
    entrypoint: z.string().trim().min(1).optional(),
    /** Non-secret external policy settings; persisted with the method. */
    config: z.record(z.string(), z.string()).optional(),
    /** Variable names copied from the daemon environment into solve only. */
    passEnv: z.array(EnvName).optional(),
  })
  .refine((m) => !isCliMethod(m) || Boolean(m.auth), {
    message: "CLI agent methods need an auth profile",
  })
  .refine((m) => m.agent !== "external" || (Boolean(m.entrypoint) && !m.auth && !m.bundle), {
    message: "external methods need an entrypoint and take no auth profile or CLI bundle",
  })
  .refine((m) => m.agent === "external" || (!m.entrypoint && !m.config && !m.passEnv), {
    message: "entrypoint, config and passEnv are only for external methods",
  });
export type Method = z.infer<typeof Method>;

export const BenchJobSpec = z.object({
  name: z.string().max(200).optional(),
  benchmark: ProfileName,
  /** Task ids; default: every supported task. */
  tasks: z.array(z.string()).default([]),
  methods: z.array(Method).min(1),
  /** Repetitions per task × method. */
  seeds: z.number().int().min(1).max(100).default(1),
  /** Adapter options, e.g. asi `promptLevel` (default b1). */
  options: z.record(z.string(), z.string()).default({}),
  checkpoint: CheckpointPolicy.optional(),
  /** Override the per-task solve timeout. */
  timeoutMin: z.number().positive().optional(),
});
export type BenchJobSpec = z.infer<typeof BenchJobSpec>;
export type BenchJobSpecInput = z.input<typeof BenchJobSpec>;

export const Evaluation = z.enum(["valid", "invalid", "unknown"]);
export type Evaluation = z.infer<typeof Evaluation>;

/**
 * Kinds of review content the Web UI renders, each with its own built-in style. The set is closed:
 * an adapter picks a kind, it never sends markup or styles. Unknown kinds are kept and shown with
 * their `fallback` kind, else by file extension, else as text.
 */
export const REVIEW_KINDS = ["markdown", "image", "text", "json", "table", "trajectory"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

/** Row zero is the initial observation; later rows contain each action's resulting observation. */
export const GuiTrajectory = z
  .object({
    version: z.literal(1),
    goal: z.string().max(100_000),
    steps: z
      .array(
        z.object({
          step: z.number().int().nonnegative(),
          screenshot: z
            .string()
            .min(1)
            .refine(
              (p) =>
                !/^[a-z][a-z\d+.-]*:/i.test(p) &&
                !p.includes("\\") &&
                !Array.from(p).some((char) => char.charCodeAt(0) < 32) &&
                p.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
              "screenshot must stay in the run output",
            ),
          action: z
            .string()
            .refine((action) => action.trim().length > 0, "action must not be blank")
            .nullable(),
          reward: z.number().nullable(),
          actionError: z.string().optional(),
          terminated: z.boolean().optional(),
          truncated: z.boolean().optional(),
          observation: z.string().optional(),
        }),
      )
      .min(1)
      .max(10001),
    stopReason: z.string().optional(),
  })
  .refine(
    (t) =>
      t.steps.every((s, i) => s.step === i && (i === 0 ? s.action === null : s.action !== null)),
    "trajectory must start with an initial observation and contain consecutive action steps",
  );
export type GuiTrajectory = z.infer<typeof GuiTrajectory>;
const LIMIT_TEXT = 20_000;
const clipText = (max: number) =>
  z.string().transform((s) => (s.length > max ? `${s.slice(0, max)}…` : s));

/** A file of the solve or verify run to show on the trial page. */
export const ReviewFile = z.looseObject({
  label: clipText(60),
  phase: z.enum(["solve", "verify"]),
  /** Relative to the run's output directory, without `..`. */
  path: z
    .string()
    .min(1)
    .refine(
      (p) => !p.startsWith("/") && !p.split("/").includes(".."),
      "path must stay in the output",
    ),
  /** One of REVIEW_KINDS, or a newer kind an older Orbit does not know (then `fallback` is used). */
  kind: z.string().max(40).optional(),
  fallback: z.enum(REVIEW_KINDS).optional(),
});
export type ReviewFile = z.infer<typeof ReviewFile>;

/** One graded criterion. */
export const ReviewItem = z.looseObject({
  criterion: clipText(4000),
  score: z.number().nullable().optional(),
  maxScore: z.number().optional(),
  weight: z.number().optional(),
  /** Free label, e.g. `text` / `image` / `test`. */
  type: clipText(40).optional(),
  reasoning: clipText(LIMIT_TEXT).optional(),
});
export type ReviewItem = z.infer<typeof ReviewItem>;

/**
 * What the trial page shows besides the score: files to render, graded items, and short key/value
 * details. Fields Orbit does not know are kept and listed under Details.
 */
export const Review = z.looseObject({
  files: z.array(ReviewFile).max(20).default([]),
  items: z.array(ReviewItem).max(500).default([]),
  /** Short facts shown as a key/value table (scorer model, attempts, ...). */
  details: z
    .record(z.string().max(80), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]))
    .refine((d) => Object.keys(d).length <= 50, "at most 50 details")
    .default({}),
});
export type Review = z.infer<typeof Review>;

/** Execution, evaluation and cleanup are separate: only `valid` scores enter means. */
export const Outcome = z.object({
  /** How the solve run ended (RunState, or `skipped`). */
  execution: z.string(),
  evaluation: Evaluation,
  score: z.number().nullable(),
  maxScore: z.number(),
  issues: z.array(z.string()),
  cleanup: z.enum(["pending", "done", "failed"]),
  /** What the adapter asked the trial page to show (null for older trials and adapters). */
  review: Review.nullable().default(null),
  /** Adapter metrics of the trial (besides `score`); kept also when the score is not trusted. */
  metrics: z.record(z.string(), z.number()).optional(),
});
export type Outcome = z.infer<typeof Outcome>;

/** A scoring of a trial that a rescore replaced: its verify run and outcome. */
export const Scoring = z.object({
  verifyRunId: z.string().nullable(),
  outcome: Outcome,
  endedAt: z.string().nullable(),
});
export type Scoring = z.infer<typeof Scoring>;

export const TrialState = z.enum(["pending", "solving", "verifying", "done"]);
export const Trial = z.object({
  id: z.string(),
  jobId: z.string(),
  task: z.string(),
  method: z.string(),
  seed: z.number().int(),
  state: TrialState,
  solveRunId: z.string().nullable(),
  verifyRunId: z.string().nullable(),
  /** Notes gathered before the outcome (e.g. artifacts the solve run did not produce). */
  issues: z.array(z.string()).default([]),
  outcome: Outcome.nullable(),
  /**
   * Earlier scorings, oldest first. A rescore moves the current verify run and outcome here and
   * verifies the same solve run again; `verifyRunId` / `outcome` are always the latest.
   */
  history: z.array(Scoring).default([]),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
});
export type Trial = z.infer<typeof Trial>;

/** Every run a trial has had: its solve run, its verify run and earlier verify runs. */
export function trialRunIds(t: Trial): string[] {
  return [t.solveRunId, t.verifyRunId, ...t.history.map((h) => h.verifyRunId)].filter(
    (r): r is string => Boolean(r),
  );
}

/** Merge completed retries or append new tasks, preserving their evaluation validity. */
export const BenchConsolidate = z.strictObject({
  /** Import previously absent tasks, including invalid outcomes and their artifacts. */
  appendTasks: z.boolean().default(false),
  /** Allow proxy/host-network aliases of the same checkout and credential. */
  allowTransportDifferences: z.boolean().default(false),
  /** Adopt successful solves over failed attempts; retain completed invalid attempts over non-valid slots. */
  replaceFailed: z.boolean().default(false),
  sources: z.array(z.string().min(1)).default([]),
  pruneInvalid: z.boolean().default(false),
  dryRun: z.boolean().default(true),
  /** Digest of the preview the caller confirmed. */
  expect: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type BenchConsolidateInput = z.input<typeof BenchConsolidate>;
export const BenchConsolidateResult = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  dryRun: z.boolean(),
  adopted: z.array(
    z.object({
      task: z.string(),
      sourceJob: z.string(),
      sourceTrial: z.string(),
      trial: z.string(),
    }),
  ),
  /** Trials whose non-invalid outcomes became invalid because their Agent could not work. */
  reclassified: z.array(
    z.object({ job: z.string(), trial: z.string(), task: z.string(), kind: z.string() }),
  ),
  removedJobs: z.array(z.string()),
  removedRuns: z.array(z.string()),
  leftovers: z.array(z.string()),
});
export type BenchConsolidateResult = z.infer<typeof BenchConsolidateResult>;

/** Which finished trials of a job to score again (all of them when nothing is given). */
export const BenchRescore = z.object({
  tasks: z.array(z.string()).default([]),
  methods: z.array(z.string()).default([]),
  trials: z.array(z.string()).default([]),
});
export type BenchRescoreInput = z.input<typeof BenchRescore>;
export const BenchRescoreResult = z.object({
  /** Trials now being verified again. */
  trials: z.array(z.string()),
  /** Matching trials left as they are, with why. */
  skipped: z.array(z.object({ trial: z.string(), reason: z.string() })),
});
export type BenchRescoreResult = z.infer<typeof BenchRescoreResult>;

/** Solve resources of one task; `evidence` / `confidence` / `note` are for people and ignored. */
export const TaskResources = z.strictObject({
  cpus: z.number().positive().optional(),
  memGB: z.number().positive().optional(),
  gpus: z.number().int().min(0).optional(),
  gpuMemGB: z.number().positive().optional(),
  timeoutMin: z.number().positive().optional(),
  evidence: z.string().optional(),
  confidence: z.string().optional(),
  note: z.string().optional(),
});
export type TaskResources = z.infer<typeof TaskResources>;

/**
 * A benchmark's resources file: `default` and per-task entries override what the adapter asks for
 * the solve run (a task entry over `default` over the adapter; `orbit bench run --timeout` wins).
 */
export const BenchResources = z.strictObject({
  version: z.literal(1),
  note: z.string().optional(),
  default: TaskResources.default({}),
  tasks: z.record(z.string(), TaskResources).default({}),
});
export type BenchResources = z.infer<typeof BenchResources>;

/** Resolved overrides for one task (the fields Orbit applies). */
export const ResourceOverride = TaskResources.pick({
  cpus: true,
  memGB: true,
  gpus: true,
  gpuMemGB: true,
  timeoutMin: true,
});
export type ResourceOverride = z.infer<typeof ResourceOverride>;

export const BenchJob = z.object({
  id: z.string(),
  spec: BenchJobSpec,
  /** Non-secret registration fixed at submission; absent only for legacy jobs. */
  benchmarkSnapshot: Benchmark.optional(),
  capabilities: BenchCapabilities.optional(),
  /** Per-task overrides read from the benchmark's resources file at submit (null without one). */
  resources: z.record(z.string(), ResourceOverride).nullable().default(null),
  /** Folder for organizing; the job's runs follow it. */
  folder: Folder.default(""),
  /** Metrics declared by the adapter at submit, `score` first (only `score` for older jobs). */
  metrics: z.array(MetricSpec).default([]),
  /** The benchmark checkout at submit (null outside git, or for older jobs). */
  source: z
    .object({ commit: z.string(), describe: z.string().nullable(), dirty: z.boolean() })
    .nullable()
    .default(null),
  state: z.enum(["running", "done", "cancelled"]),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
});
export type BenchJob = z.infer<typeof BenchJob>;

/** A metric over tasks (see `contracts/metrics.ts`): SE clustered by task, 95% CI. */
export const MetricStat = z.object({
  mean: z.number(),
  se: z.number().nullable(),
  ci: z.tuple([z.number(), z.number()]).nullable(),
  tasks: z.number().int(),
  trials: z.number().int(),
});
export type MetricStat = z.infer<typeof MetricStat>;

export const MethodSummary = z.object({
  method: z.string(),
  trials: z.number().int(),
  valid: z.number().int(),
  invalid: z.number().int(),
  unknown: z.number().int(),
  pending: z.number().int(),
  /** Per metric name: mean over tasks of the per-task mean of valid trials; null without any. */
  metrics: z.record(z.string(), MetricStat.nullable()),
});
export type MethodSummary = z.infer<typeof MethodSummary>;

export const BenchJobDetail = z.object({
  job: BenchJob,
  trials: z.array(Trial),
  summary: z.array(MethodSummary),
});
export type BenchJobDetail = z.infer<typeof BenchJobDetail>;

export const BenchJobList = z.object({
  jobs: z.array(BenchJob.extend({ summary: z.array(MethodSummary) })),
});
export type BenchJobList = z.infer<typeof BenchJobList>;

export const BenchmarkList = z.object({ benchmarks: z.array(Benchmark) });
export const BenchTaskList = z.object({
  tasks: z.array(BenchTask),
  metrics: z.array(MetricSpec).default([]),
  capabilities: BenchCapabilities.optional(),
});
export type BenchTaskList = z.infer<typeof BenchTaskList>;

/** Methods from several jobs side by side; columns are `<job>/<method>`. */
export const BenchCompare = z.object({
  columns: z.array(z.object({ key: z.string(), jobId: z.string(), method: z.string() })),
  /** Metrics every compared job has (always `score`); the first job's primary one if shared. */
  metrics: z.array(MetricSpec),
  rows: z.array(
    z.object({
      task: z.string(),
      /** Evaluation counts per column: `valid/total` (empty when the column has no such trial). */
      counts: z.record(z.string(), z.string()),
      /** Per metric, per column: mean over the task's valid trials; null when none has a value. */
      values: z.record(z.string(), z.record(z.string(), z.number().nullable())),
    }),
  ),
  /**
   * Per metric: tasks with a value in every column (`paired`), and per column the mean over all its
   * tasks, over the paired tasks, and the paired difference to the first column.
   */
  stats: z.record(
    z.string(),
    z.object({
      pairedTasks: z.number().int(),
      columns: z.record(
        z.string(),
        z.object({
          all: MetricStat.nullable(),
          paired: MetricStat.nullable(),
          diff: MetricStat.nullable(),
        }),
      ),
    }),
  ),
});
export type BenchCompare = z.infer<typeof BenchCompare>;

/** Measured solve use per task over one or more jobs, with a suggested resources entry. */
export const BenchUsageRow = z.object({
  task: z.string(),
  /** Solve runs with usage samples. */
  runs: z.number().int(),
  requested: ResourceOverride,
  peakMemGB: z.number().nullable(),
  peakGpuMemGB: z.number().nullable(),
  peakCpus: z.number().nullable(),
  meanCpus: z.number().nullable(),
  /** Longest solve run, in minutes. */
  maxMinutes: z.number().nullable(),
  /** Runs that ended out of memory / had processes killed for memory / timed out. */
  oomKilled: z.number().int(),
  oomKills: z.number().int(),
  timeouts: z.number().int(),
  /** Fields worth changing (empty when the request fits), and why. */
  suggest: ResourceOverride,
  notes: z.array(z.string()),
});
export type BenchUsageRow = z.infer<typeof BenchUsageRow>;
export const BenchUsage = z.object({ jobs: z.array(z.string()), rows: z.array(BenchUsageRow) });
export type BenchUsage = z.infer<typeof BenchUsage>;

export function isAgentMethod(m: { agent: string }): boolean {
  return isCliMethod(m) || m.agent === "external";
}

export function isCliMethod(m: { agent: string }): boolean {
  return m.agent === "codex" || m.agent === "claude-code";
}
