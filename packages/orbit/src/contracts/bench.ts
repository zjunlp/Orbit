import { z } from "zod";
import {
  BENCH_CATEGORIES,
  CATEGORY_PROFILES,
  type BenchCategory as Category,
} from "./categories.ts";
import { EnvName, ProfileName } from "./common.ts";
import { Folder } from "./folders.ts";
import { CheckpointPolicy } from "./runs.ts";

/** Adapters shipped with Orbit (`orbit __adapter <name>`). */
export const BUILTIN_ADAPTERS = ["harbor", "asi", "manifest"] as const;

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

/** How much of a benchmark Orbit can run, by suite and by reason (`orbit bench coverage`). */
export interface BenchCoverage {
  total: number;
  supported: number;
  suites: { suite: string; total: number; supported: number }[];
  /** Normalized reasons, most frequent first; a task with several reasons counts for each. */
  reasons: { reason: string; tasks: number; suites: string[] }[];
}

/** A task's suite: its `suite` tag, else the id up to the first `.`, `:` or `/`. */
export function taskSuite(t: Pick<BenchTask, "id" | "tags">): string {
  return t.tags.suite || (/^([^.:/]+)[.:/]/.exec(t.id)?.[1] ?? "-");
}

/** One reason without the parts that name a single task (service names, variable help texts). */
export function normalizeReason(reason: string): string {
  return reason
    .trim()
    .replace(/^compose service (?!main:)[\w.-]+:/, "compose service <service>:")
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*):\?[^}]*\}/g, "${$1}")
    .slice(0, 240);
}

export function benchCoverage(tasks: Pick<BenchTask, "id" | "tags" | "supported" | "reason">[]) {
  const suites = new Map<string, { suite: string; total: number; supported: number }>();
  const reasons = new Map<string, { reason: string; tasks: number; suites: Set<string> }>();
  for (const t of tasks) {
    const suite = taskSuite(t);
    const row = suites.get(suite) ?? { suite, total: 0, supported: 0 };
    row.total++;
    if (t.supported) row.supported++;
    suites.set(suite, row);
    if (t.supported) continue;
    for (const reason of new Set((t.reason ?? "unsupported").split("; ").map(normalizeReason))) {
      const r = reasons.get(reason) ?? { reason, tasks: 0, suites: new Set<string>() };
      r.tasks++;
      r.suites.add(suite);
      reasons.set(reason, r);
    }
  }
  return {
    total: tasks.length,
    supported: tasks.filter((t) => t.supported).length,
    suites: [...suites.values()].sort(
      (a, b) => b.total - a.total || a.suite.localeCompare(b.suite),
    ),
    reasons: [...reasons.values()]
      .sort((a, b) => b.tasks - a.tasks || a.reason.localeCompare(b.reason))
      .map((r) => ({ ...r, suites: [...r.suites].sort() })),
  } satisfies BenchCoverage;
}

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

/**
 * Method kinds that are not Agent CLIs. They cannot be registered as Agent names (`policy` is
 * reserved for model-service methods and not runnable yet).
 */
export const RESERVED_METHOD_AGENTS = ["external", "oracle", "empty", "policy"] as const;
/** Runnable non-CLI method kinds. */
export const SPECIAL_METHOD_AGENTS = ["external", "oracle", "empty"] as const;
/** Kept for older imports: the method kinds Orbit shipped with before the Agent registry. */
export const METHOD_AGENTS = ["codex", "claude-code", ...SPECIAL_METHOD_AGENTS] as const;

/**
 * A method's `agent`: a special kind, or the name of a registered Agent (checked against the
 * registry when a job is submitted, not here).
 */
export const MethodAgent = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "agent must be an Agent name or external/oracle/empty")
  .refine((a) => a !== "policy", "policy methods are reserved and not supported yet");
export type MethodAgent = z.infer<typeof MethodAgent>;

/**
 * What an adapter accepts. Concrete names keep their meaning (`codex` means only Codex); `cli`
 * explicitly admits every registered Agent CLI.
 */
export const CapabilityMethod = z.union([MethodAgent, z.literal("cli")]);

/** Whether a capability list admits a method's agent. */
export function capabilityAllows(methods: readonly string[], agent: string): boolean {
  return methods.includes(agent) || (methods.includes("cli") && isCliMethod({ agent }));
}

export const BenchCategory = z.enum(BENCH_CATEGORIES);
export type BenchCategory = Category;

const Range = z.object({ min: z.number(), max: z.number() }).refine((r) => r.max >= r.min);
/**
 * What calibration may expect of a benchmark (`orbit bench calibrate`). Categories have defaults
 * (`calibrationDefaults`); a benchmark overrides them where its rules differ (e.g. a do-nothing
 * policy that can already satisfy a goal, or a judge that is not exactly repeatable).
 */
export const CalibrationExpect = z.object({
  /** `min`: 0; `any`: no expectation; or a range. */
  empty: z.union([z.literal("min"), z.literal("any"), Range]).optional(),
  /** `max`: full marks; `none`: no reference solution; or a range. */
  oracle: z.union([z.literal("max"), z.literal("none"), Range]).optional(),
  /** `exact`, or the largest allowed spread of repeated seeds of a task × method. */
  repeat: z
    .union([z.literal("exact"), z.object({ tolerance: z.number().nonnegative() })])
    .optional(),
  /** Repeated seeds are different episodes (initial states), not repeats of one. */
  seedsVary: z.boolean().optional(),
});
export type CalibrationExpect = z.infer<typeof CalibrationExpect>;

export function calibrationDefaults(
  category: Category | null,
): Required<Pick<CalibrationExpect, "empty" | "oracle" | "repeat">> & { seedsVary: boolean } {
  switch (category) {
    case "embodied-policy":
      // A still policy can satisfy a goal that holds at the start; seeds pick initial states.
      return { empty: "any", oracle: "max", repeat: "exact", seedsVary: true };
    case "fixed-input":
      return { empty: "any", oracle: "max", repeat: "exact", seedsVary: false };
    case "user-session":
    case "game":
      return { empty: "min", oracle: "none", repeat: { tolerance: 1 }, seedsVary: false };
    default:
      return { empty: "min", oracle: "max", repeat: "exact", seedsVary: false };
  }
}

export const BenchCapabilities = z
  .object({
    category: BenchCategory.optional(),
    profiles: z.array(z.string().max(40)).max(12).default([]),
    /** Subject-area tags shown in the UI (e.g. `embodied`), independent of the category. */
    domains: z
      .array(z.string().regex(/^[a-z][a-z0-9-]{0,30}$/))
      .max(6)
      .default([]),
    /** Kept for older adapters; a GUI platform when the category is `gui`. */
    kind: z.enum(["browser", "desktop", "mobile", "other"]).default("other"),
    methods: z.array(CapabilityMethod).min(1),
    conditions: z.record(z.string().max(80), z.string().max(2000)),
    scoreKind: z.enum(["binary", "scalar"]),
    rescore: z.enum(["evidence", "score", "none"]),
    /** Agent capabilities (registry `capabilities`) a CLI method needs; checked on submission. */
    requires: z.array(z.enum(["oneShot", "multiTurn", "mcp", "gui"])).default([]),
    calibration: CalibrationExpect.optional(),
    /**
     * Comparison with the benchmark's own runner or published results (design §9.10), which Orbit
     * cannot establish by itself: `sample-aligned` (native runner on sampled tasks agrees) or
     * `agent-compared` (a real Agent / policy scored as officially reported), with its evidence.
     */
    parity: z
      .object({
        level: z.enum(["sample-aligned", "agent-compared"]),
        evidence: z.string().max(2000),
        checkedAt: z.string().max(40).optional(),
      })
      .optional(),
  })
  .superRefine((c, ctx) => {
    if (!c.category) return;
    const allowed = CATEGORY_PROFILES[c.category];
    for (const p of c.profiles)
      if (!allowed.includes(p))
        ctx.addIssue({
          code: "custom",
          path: ["profiles"],
          message: `${c.category} has no profile ${p} (one of ${allowed.join(", ")})`,
        });
  });
export type BenchCapabilities = z.infer<typeof BenchCapabilities>;

/**
 * An AgentProfile: harness (with the host CLI version recorded per run) + model + auth + method
 * bundle, or an adapter-owned external policy. `oracle` and `empty` calibrate an adapter.
 */
export const Method = z
  .object({
    name: ProfileName,
    agent: MethodAgent,
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

/**
 * Marks a calibration job (design §9.15), fixed at submission: tasks whose reference solution is
 * partial or missing (their oracle trials are not judged) and whether to rescore once it ends.
 */
export const JobCalibration = z.object({
  noOracle: z.array(z.string()).default([]),
  rescore: z.boolean().default(true),
});
export type JobCalibration = z.infer<typeof JobCalibration>;

/** `POST /bench/calibrations`: sample tasks (or take the given ones) and calibrate them. */
export const CalibrationRequest = z.strictObject({
  benchmark: ProfileName,
  tasks: z.array(z.string()).default([]),
  sample: z.number().int().min(1).max(100).default(3),
  suite: z.string().optional(),
  seeds: z.number().int().min(1).max(10).default(2),
  oracle: z.boolean().default(true),
  rescore: z.boolean().default(true),
  timeoutMin: z.number().positive().optional(),
});
export type CalibrationRequestInput = z.input<typeof CalibrationRequest>;

export const CheckResult = z.enum(["passed", "failed", "not_run"]);
export type CheckResult = z.infer<typeof CheckResult>;
export const CalibrationCheck = z.object({
  name: z.string(),
  result: CheckResult,
  detail: z.string(),
  /** Trials the check failed on, for links to their evidence. */
  trials: z.array(z.string()).default([]),
});
export type CalibrationCheck = z.infer<typeof CalibrationCheck>;

/** A calibration job's judgement, computed from its trials whenever it is read. */
export const CalibrationReport = z.object({
  benchmark: z.string(),
  job: z.string(),
  tasks: z.array(z.string()),
  methods: z.array(z.string()),
  seeds: z.number().int(),
  /** `running`: trials not finished; `rescoring`: the rescore from saved evidence is in progress. */
  phase: z.enum(["running", "rescoring", "done"]),
  checks: z.array(CalibrationCheck),
  /** Done, no check failed and at least one passed (`not_run` checks are listed, not counted). */
  calibrated: z.boolean(),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
  /** The benchmark checkout at submission, so a later change can be told apart. */
  source: z.object({ commit: z.string(), dirty: z.boolean() }).nullable(),
});
export type CalibrationReport = z.infer<typeof CalibrationReport>;

export const BenchJobSpec = z.object({
  name: z.string().max(200).optional(),
  calibration: JobCalibration.optional(),
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
export const REVIEW_KINDS = [
  "markdown",
  "image",
  "text",
  "json",
  "table",
  "trajectory",
  "episode",
] as const;
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
/**
 * Why a trial produced no trustworthy result, as a closed set (design §9.7). Free-text issues keep
 * the detail; this field is for counting and filtering.
 */
export const FAILURE_KINDS = [
  "infra",
  "agent_install",
  "env_start",
  "env_step",
  "reset_failed",
  "policy_start",
  "policy_act",
  "server_unreachable",
  "call_watchdog",
  "resume_failed",
  "scorer_error",
  "judge_unavailable",
  "model_unavailable",
  "budget_exceeded",
] as const;
export const FailureKind = z.enum(FAILURE_KINDS);
export type FailureKind = z.infer<typeof FailureKind>;

/** How an interactive episode ended, when the adapter knows (GUI and embodied benchmarks). */
export const Episode = z.object({
  steps: z.number().int().nonnegative().optional(),
  terminated: z.boolean().optional(),
  truncated: z.boolean().optional(),
  /** Who or what ended it, e.g. `agent`, `step_limit`, `time_limit`, `success`. */
  endedBy: z.string().max(80).optional(),
  /** How success was signalled, e.g. `early_stop`, `hidden`, `final_state`. */
  successSignal: z.string().max(80).optional(),
});
export type Episode = z.infer<typeof Episode>;

/**
 * A benchmark's own aggregation rule (design §9.7), declared by its adapter and fixed per job.
 * `errors`: whether invalid trials are left out (`exclude`) or count as a failed sample with
 * `failValue` (`fail`, as harnesses that put infrastructure errors in the denominator).
 * `unit`: the mean over all samples (`sample`) or the mean of per-task means (`task`).
 */
export const OfficialRule = z.object({
  name: z.string().min(1).max(80),
  version: z.string().max(40).optional(),
  metric: z.string().optional(),
  errors: z.enum(["exclude", "fail"]),
  unit: z.enum(["sample", "task"]),
  failValue: z.number().default(0),
});
export type OfficialRule = z.infer<typeof OfficialRule>;

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
  /** Why the result is not trustworthy, when the classification or the adapter knows. */
  failure: FailureKind.optional(),
  episode: Episode.optional(),
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
  /** The benchmark's own aggregation rule at submission, when its adapter declares one. */
  official: OfficialRule.optional(),
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
  /**
   * A calibration job's rescore step, run by the daemon once its trials have ended: `started` while
   * rescoring, `done` afterwards (`note`: why it was skipped or partial).
   */
  rescore: z.object({ state: z.enum(["started", "done"]), note: z.string().optional() }).optional(),
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

/** The benchmark's own aggregate of one method (design §9.7), next to Orbit's valid-only view. */
export const OfficialValue = z.object({
  metric: z.string(),
  value: z.number().nullable(),
  /** Samples in the denominator under the rule. */
  samples: z.number().int(),
  /** Planned samples not finished (pending, cancelled or lost): the value is then partial. */
  missing: z.number().int(),
  partial: z.boolean(),
});
export type OfficialValue = z.infer<typeof OfficialValue>;

export const MethodSummary = z.object({
  method: z.string(),
  trials: z.number().int(),
  valid: z.number().int(),
  invalid: z.number().int(),
  unknown: z.number().int(),
  pending: z.number().int(),
  /** Per metric name: mean over tasks of the per-task mean of valid trials; null without any. */
  metrics: z.record(z.string(), MetricStat.nullable()),
  /** Under the benchmark's own rule; absent when the adapter declares none. */
  official: OfficialValue.optional(),
});
export type MethodSummary = z.infer<typeof MethodSummary>;

/** One planned sample in a report: the trial (attempt) whose result was used and its value. */
export const ReportEntry = z.object({
  trial: z.string(),
  /** `<task>#<seed>`: the logical sample, stable across retries and merges. */
  sample: z.string(),
  task: z.string(),
  seed: z.number().int(),
  solveRunId: z.string().nullable(),
  verifyRunId: z.string().nullable(),
  /** `pending` when the trial has no outcome yet. */
  evaluation: z.enum(["valid", "invalid", "unknown", "pending"]),
  failure: FailureKind.optional(),
  /** The primary metric (Orbit's view uses valid entries only). */
  value: z.number().nullable(),
});
export type ReportEntry = z.infer<typeof ReportEntry>;

/**
 * An immutable result of a job at one point (design §9.7): the plan it covers, the attempts it used
 * and both views. A rescore, merge or append writes a new revision; earlier ones are kept.
 */
export const BenchReport = z.object({
  jobId: z.string(),
  revision: z.number().int().min(1),
  createdAt: z.string(),
  reason: z.enum(["finished", "cancelled", "rescore", "consolidate", "backfill"]),
  /** sha256 of the planned samples (tasks × seeds × methods); appending tasks changes it. */
  planDigest: z.string(),
  aggregator: z.string(),
  metric: z.string(),
  official: OfficialRule.nullable(),
  methods: z.array(
    z.object({
      method: z.string(),
      planned: z.number().int(),
      completed: z.number().int(),
      valid: z.number().int(),
      invalid: z.number().int(),
      unknown: z.number().int(),
      missing: z.number().int(),
      failures: z.record(z.string(), z.number().int()),
      orbit: MetricStat.nullable(),
      official: OfficialValue.nullable(),
      entries: z.array(ReportEntry),
    }),
  ),
});
export type BenchReport = z.infer<typeof BenchReport>;

export const BenchJobDetail = z.object({
  job: BenchJob,
  trials: z.array(Trial),
  summary: z.array(MethodSummary),
  /** For calibration jobs (`spec.calibration`). */
  calibration: CalibrationReport.optional(),
});
export type BenchJobDetail = z.infer<typeof BenchJobDetail>;

export const BenchJobList = z.object({
  jobs: z.array(BenchJob.extend({ summary: z.array(MethodSummary) })),
});
export type BenchJobList = z.infer<typeof BenchJobList>;

export const BenchmarkList = z.object({ benchmarks: z.array(Benchmark) });

/** A method that is not a calibration method, by what makes it the same method across jobs. */
export const CatalogMethod = z.object({
  /** `agent · model · effort` (or the external entrypoint). */
  key: z.string(),
  agent: z.string(),
  model: z.string().nullable(),
  jobs: z.number().int(),
  /** The latest job that ran it. */
  latest: z.object({
    job: z.string(),
    method: z.string(),
    createdAt: z.string(),
    state: z.string(),
    summary: MethodSummary,
  }),
});
export type CatalogMethod = z.infer<typeof CatalogMethod>;

/**
 * One registered benchmark on the catalog page (design §9.15): what it is and can run, whether its
 * integration was calibrated, which real methods ran, and its parity with the original.
 */
export const CatalogEntry = z.object({
  benchmark: Benchmark,
  /** The adapter's task listing (cached by the daemon); null until the first listing finished. */
  listing: z
    .object({
      at: z.string(),
      capabilities: BenchCapabilities.nullable(),
      metrics: z.array(MetricSpec),
      official: OfficialRule.nullable(),
      coverage: z.object({
        total: z.number().int(),
        supported: z.number().int(),
        suites: z.array(
          z.object({ suite: z.string(), total: z.number().int(), supported: z.number().int() }),
        ),
        reasons: z.array(
          z.object({ reason: z.string(), tasks: z.number().int(), suites: z.array(z.string()) }),
        ),
      }),
      /** Tasks with a full reference solution (`oracle` tag), when the adapter tags them. */
      oracleTasks: z.number().int().nullable(),
    })
    .nullable(),
  /** The listing's capabilities, else those of the newest job (so a row has a category early). */
  capabilities: BenchCapabilities.nullable(),
  /** The last listing failed (an earlier one may still be shown). */
  listingError: z.string().nullable(),
  /** A listing is being refreshed now. */
  refreshing: z.boolean(),
  /** Calibration jobs, newest first (at most five). */
  calibrations: z.array(CalibrationReport),
  /** Jobs of this benchmark (all methods). */
  jobs: z.number().int(),
  methods: z.array(CatalogMethod),
  /** Highest fidelity level with evidence (design §9.10). */
  fidelity: z.enum(["experimental", "calibrated", "sample-aligned", "agent-compared"]),
});
export type CatalogEntry = z.infer<typeof CatalogEntry>;
export const BenchCatalog = z.object({ entries: z.array(CatalogEntry) });
export type BenchCatalog = z.infer<typeof BenchCatalog>;
export const BenchTaskList = z.object({
  tasks: z.array(BenchTask),
  metrics: z.array(MetricSpec).default([]),
  capabilities: BenchCapabilities.optional(),
  official: OfficialRule.optional(),
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

/** Any method whose agent is not a reserved kind runs an Agent CLI from the registry. */
export function isCliMethod(m: { agent: string }): boolean {
  return !(RESERVED_METHOD_AGENTS as readonly string[]).includes(m.agent);
}
