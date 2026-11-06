import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  BenchCompare,
  BenchJob,
  BenchReport,
  MethodSummary,
  MetricSpec,
  OfficialRule,
  OfficialValue,
  Outcome,
  ReportEntry,
  Trial,
} from "../contracts/index.ts";
import { sampleIdentity, sampleKey, sampleOrder } from "../contracts/index.ts";
import {
  aggregate,
  metricValue,
  pairedDiff,
  primaryMetric,
  resolveMetrics,
  taskMeans,
} from "../contracts/metrics.ts";
import { contentDigest } from "./samples.ts";

export const isValid = (t: Trial) => t.outcome?.evaluation === "valid";

/** Version of the report computation; recorded in every report. */
export const REPORT_AGGREGATOR = "orbit-report/1";

/**
 * Digest of a job's planned samples: benchmark, tasks, seeds and methods (name + agent). Appending
 * tasks or seeds yields a new digest, i.e. a new plan version.
 */
export function planDigest(
  job: Pick<BenchJob, "spec"> & Partial<Pick<BenchJob, "resolvedBindings" | "benchmarkSnapshot">>,
): string {
  const s = job.spec;
  if (s.samplePlan) {
    const plan = {
      version: 2,
      benchmark: s.benchmark,
      benchmarkSnapshot: job.benchmarkSnapshot,
      samplePlan: s.samplePlan.digest,
      methods: [...s.methods].sort((a, b) => a.name.localeCompare(b.name)),
      resolvedBindings: job.resolvedBindings,
      options: Object.entries(s.options).sort(),
    };
    return contentDigest(plan);
  }
  const plan = {
    benchmark: s.benchmark,
    tasks: [...s.tasks].sort(),
    seeds: s.seeds,
    methods: s.methods.map((m) => [m.name, m.agent]).sort(),
    options: Object.entries(s.options).sort(),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(plan)).digest("hex")}`;
}

export { sampleKey };

/** One trial as a report entry; `value` is the given metric. */
function entry(t: Trial, metric: string): ReportEntry {
  return {
    trial: t.id,
    sample: sampleKey(t),
    task: t.task,
    ...sampleIdentity(t),
    solveRunId: t.solveRunId,
    verifyRunId: t.verifyRunId,
    evaluation: t.outcome?.evaluation ?? "pending",
    ...(t.outcome?.failure ? { failure: t.outcome.failure } : {}),
    value: t.outcome ? metricValue(t.outcome, metric) : null,
  };
}

/**
 * A method's value under the benchmark's own rule (design §9.7). Pending, cancelled and lost
 * samples are missing (the value is then partial); invalid ones are left out or count as
 * `failValue`, as the rule says; valid ones without a value of the metric are left out.
 */
export function officialValue(
  entries: ReportEntry[],
  rule: OfficialRule,
  metric: string,
): OfficialValue {
  const used: { task: string; v: number }[] = [];
  let missing = 0;
  for (const e of entries) {
    if (e.evaluation === "pending" || e.evaluation === "unknown") missing++;
    else if (e.evaluation === "invalid") {
      if (rule.errors === "fail") used.push({ task: e.task, v: rule.failValue });
    } else if (e.value !== null) used.push({ task: e.task, v: e.value });
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  let value: number | null;
  if (rule.unit === "sample") value = mean(used.map((u) => u.v));
  else {
    const by = new Map<string, number[]>();
    for (const u of used) by.set(u.task, [...(by.get(u.task) ?? []), u.v]);
    value = mean([...by.values()].map((xs) => mean(xs) as number));
  }
  return { metric, value, samples: used.length, missing, partial: missing > 0 };
}

/** The metric a job's official rule is about: the rule's own, else the job's primary metric. */
export const officialMetric = (rule: OfficialRule, metrics: MetricSpec[]) =>
  rule.metric ?? primaryMetric(resolveMetrics(metrics)).name;

/** Per method: trial counts and every metric over its valid trials (per task first, then tasks). */
export function summarize(
  methods: string[],
  trials: Trial[],
  metrics: MetricSpec[] = [],
  official?: OfficialRule,
): MethodSummary[] {
  const specs = resolveMetrics(metrics);
  return methods.map((method) => {
    const ts = trials.filter((t) => t.method === method);
    const done = ts.filter((t) => t.outcome);
    const count = (e: Outcome["evaluation"]) =>
      done.filter((t) => t.outcome?.evaluation === e).length;
    const valid = done.filter(isValid);
    return {
      method,
      trials: ts.length,
      valid: valid.length,
      invalid: count("invalid"),
      unknown: count("unknown"),
      pending: ts.length - done.length,
      metrics: Object.fromEntries(specs.map((m) => [m.name, aggregate(taskMeans(valid, m.name))])),
      ...(official
        ? {
            official: officialValue(
              ts.map((t) => entry(t, officialMetric(official, metrics))),
              official,
              officialMetric(official, metrics),
            ),
          }
        : {}),
    };
  });
}

/**
 * A report of a job's current results (design §9.7): per method, every planned sample with the
 * attempt used, counts, failures, Orbit's valid-only view of the primary metric and the official
 * value. Pure; the caller assigns the revision and stores it.
 */
export function buildReport(
  job: BenchJob,
  trials: Trial[],
  reason: BenchReport["reason"],
  revision: number,
  at: string,
): BenchReport {
  const metric = primaryMetric(resolveMetrics(job.metrics)).name;
  const rule = job.official ?? null;
  return {
    jobId: job.id,
    revision,
    createdAt: at,
    reason,
    planDigest: planDigest(job),
    aggregator: job.spec.samplePlan ? "orbit-report/2" : REPORT_AGGREGATOR,
    metric,
    official: rule,
    methods: job.spec.methods.map(({ name }) => {
      const ts = trials
        .filter((t) => t.method === name)
        .sort((a, b) => a.task.localeCompare(b.task) || sampleOrder(a, b));
      const entries = ts.map((t) => entry(t, metric));
      const count = (e: ReportEntry["evaluation"]) =>
        entries.filter((x) => x.evaluation === e).length;
      const failures: Record<string, number> = {};
      for (const e of entries) if (e.failure) failures[e.failure] = (failures[e.failure] ?? 0) + 1;
      const officialEntries = rule
        ? ts.map((t) => entry(t, officialMetric(rule, job.metrics)))
        : [];
      return {
        method: name,
        planned: entries.length,
        completed: entries.length - count("pending"),
        valid: count("valid"),
        invalid: count("invalid"),
        unknown: count("unknown"),
        missing: count("pending") + count("unknown"),
        failures,
        orbit: aggregate(taskMeans(ts.filter(isValid), metric)),
        official: rule
          ? officialValue(officialEntries, rule, officialMetric(rule, job.metrics))
          : null,
        entries,
      };
    }),
  };
}

/** Whether two reports say the same thing (plan, rule and every entry); then no new revision. */
export function sameReport(a: BenchReport, b: BenchReport): boolean {
  const body = (r: BenchReport) =>
    JSON.stringify([r.planDigest, r.aggregator, r.metric, r.official, r.methods]);
  return body(a) === body(b);
}

/** Metrics shared by all jobs, as the first job declares them; its primary stays primary. */
function sharedMetrics(jobs: BenchJob[]): MetricSpec[] {
  const [first, ...rest] = jobs.map((j) => resolveMetrics(j.metrics));
  const shared = (first ?? []).filter((m) => rest.every((ms) => ms.some((x) => x.name === m.name)));
  return resolveMetrics(shared);
}

/**
 * Columns `<job>/<method>`, one row per task. Per metric, a cell is the mean over the task's valid
 * trials; column means are over all its tasks and over the tasks every column has (`paired`), and
 * `diff` is the paired difference to the first column, so methods are compared on the same tasks.
 */
export function compareJobs(jobs: { job: BenchJob; trials: Trial[] }[]): BenchCompare {
  // Jobs may share a name: fall back to the job id so every column key is unique.
  const keys = new Set<string>();
  const columns = jobs.flatMap(({ job, trials }) =>
    job.spec.methods.map((m) => {
      let key = jobs.length > 1 ? `${job.spec.name ?? job.id}/${m.name}` : m.name;
      if (keys.has(key)) key = `${job.id}/${m.name}`;
      keys.add(key);
      const own = trials.filter((t) => t.method === m.name);
      return { key, jobId: job.id, method: m.name, trials: own, valid: own.filter(isValid) };
    }),
  );
  const metrics = sharedMetrics(jobs.map((j) => j.job));
  const tasks = [...new Set(jobs.flatMap(({ trials }) => trials.map((t) => t.task)))].sort();
  const means = Object.fromEntries(
    metrics.map((m) => [m.name, columns.map((c) => taskMeans(c.valid, m.name))]),
  );
  const rows = tasks.map((task) => ({
    task,
    counts: Object.fromEntries(
      columns.map((c) => {
        const ts = c.trials.filter((t) => t.task === task);
        return [c.key, ts.length ? `${ts.filter(isValid).length}/${ts.length}` : ""];
      }),
    ),
    values: Object.fromEntries(
      metrics.map((m) => [
        m.name,
        Object.fromEntries(
          columns.map((c, i) => [c.key, means[m.name]?.[i]?.get(task)?.mean ?? null]),
        ),
      ]),
    ),
  }));
  const planned = jobs.some(({ job }) => Boolean(job.spec.samplePlan));
  const conditions = (job: BenchJob) => ({
    contract: job.capabilities?.embodied,
    config: job.benchmarkSnapshot?.config,
  });
  const sameConditions =
    !planned ||
    jobs.every(
      ({ job }) =>
        job.spec.samplePlan && isDeepStrictEqual(conditions(job), conditions(jobs[0]?.job ?? job)),
    );
  const matchedSamples = (task: string) => {
    const samples = columns.map((column) =>
      column.valid
        .filter((trial) => trial.task === task)
        .map(sampleKey)
        .sort(),
    );
    return (
      sameConditions && samples.every((own) => own.length > 0 && isDeepStrictEqual(own, samples[0]))
    );
  };
  const stats: BenchCompare["stats"] = {};
  for (const m of metrics) {
    const ms = means[m.name] ?? [];
    const paired = new Set(
      tasks.filter((task) => ms.every((x) => x.has(task)) && (!planned || matchedSamples(task))),
    );
    const base = ms[0];
    stats[m.name] = {
      pairedTasks: paired.size,
      ...(planned ? { pairedTaskIds: [...paired] } : {}),
      columns: Object.fromEntries(
        columns.map((c, i) => {
          const x = ms[i] ?? new Map();
          return [
            c.key,
            {
              all: aggregate(x),
              paired: aggregate(x, paired),
              diff:
                i > 0 && base
                  ? pairedDiff(
                      planned ? new Map([...base].filter(([task]) => paired.has(task))) : base,
                      planned ? new Map([...x].filter(([task]) => paired.has(task))) : x,
                    )
                  : null,
            },
          ];
        }),
      ),
    };
  }
  return {
    columns: columns.map(({ key, jobId, method }) => ({ key, jobId, method })),
    metrics,
    rows,
    stats,
  };
}
