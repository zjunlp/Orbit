/** V0 sizing from explicit immutable A/A evidence; never submits or changes Orbit state. */
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gate, gateBenchmark } from "../packages/orbit/src/bench/gate.ts";
import { reportRunCost } from "../packages/orbit/src/bench/summary.ts";
import { fileSha256, taskSetDigest } from "../packages/orbit/src/bench/task-sets.ts";
import {
  BenchSplitManifest,
  GateRecord,
  isTerminal,
  parseTaskFile,
  Run,
} from "../packages/orbit/src/contracts/index.ts";
import { alphaAt, resolveMetrics } from "../packages/orbit/src/contracts/metrics.ts";

type Partition = "evolve" | "gate" | "final";
export interface FrozenSplit {
  manifest: BenchSplitManifest;
  content: Record<Partition, string>;
}
export interface PilotOptions {
  alpha: number;
  power: number;
  effectPoints: number;
  marginPoints: number;
}
const defaults: PilotOptions = { alpha: 0.05, power: 0.8, effectPoints: 5, marginPoints: 5 };
const parts: Partition[] = ["evolve", "gate", "final"];

/** Standard normal quantile, by inversion of a bounded CDF approximation. */
function quantile(p: number) {
  const cdf = (x: number) => {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const tail =
      (Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI)) *
      t *
      (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? 1 - tail : tail;
  };
  let lo = -9;
  let hi = 9;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** One-sided 95% Wilson upper bound; zero observed flips must not imply zero variance. */
export function flipUpper(flips: number, tasks: number): number | null {
  if (!Number.isSafeInteger(flips) || !Number.isSafeInteger(tasks) || flips < 0 || tasks < flips)
    throw new Error("invalid flip counts");
  if (!tasks) return null;
  const z = quantile(0.95);
  const p = flips / tasks;
  return Math.min(
    1,
    (p + z ** 2 / (2 * tasks) + z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * tasks)) / tasks)) /
      (1 + z ** 2 / tasks),
  );
}

export function requiredTasks(flipProbability: number, points: number, alpha = 0.05, power = 0.8) {
  if (
    !Number.isFinite(flipProbability) ||
    flipProbability < 0 ||
    flipProbability > 1 ||
    !Number.isFinite(points) ||
    points <= 0 ||
    points > 100 ||
    !Number.isFinite(alpha) ||
    alpha < 1e-12 ||
    alpha > 0.25 ||
    !Number.isFinite(power) ||
    power <= 0.5 ||
    power >= 0.999
  )
    throw new Error("invalid sizing parameters");
  const z = quantile(1 - alphaAt(1, alpha)) + quantile(power);
  return Math.max(30, Math.ceil((z ** 2 * flipProbability) / (points / 100) ** 2));
}

function validateSplit(split: FrozenSplit) {
  const manifest = BenchSplitManifest.parse(split.manifest);
  const seen = new Set<string>();
  const selected = {} as Record<Partition, Set<string>>;
  for (const part of parts) {
    const content = split.content[part];
    const ids = content.trim() ? parseTaskFile(content) : [];
    const expected = manifest.files[part];
    if (
      fileSha256(content) !== expected.sha256 ||
      taskSetDigest(ids) !== expected.taskSet ||
      ids.length !== expected.count
    )
      throw new Error(`changed frozen ${part} file`);
    for (const id of ids) {
      if (seen.has(id)) throw new Error("frozen partitions overlap");
      seen.add(id);
    }
    selected[part] = new Set(ids);
  }
  if (
    taskSetDigest(seen) !== manifest.population.taskSet ||
    seen.size !== manifest.population.count
  )
    throw new Error("frozen population differs");
  return { manifest, selected };
}

export function summarizePilot(
  record: GateRecord,
  split: FrozenSplit,
  options: Partial<PilotOptions> = {},
  runSnapshots: Run[] = [],
) {
  const settings = { ...defaults, ...options };
  requiredTasks(0.1, settings.effectPoints, settings.alpha, settings.power);
  requiredTasks(0.1, settings.marginPoints, settings.alpha, settings.power);
  record = GateRecord.parse(record);
  const verdict = gate(
    record.verdict.inputs.parent,
    record.verdict.inputs.child,
    record.policy,
    record.evidence,
    record.mode,
  );
  if (JSON.stringify(verdict) !== JSON.stringify(record.verdict))
    throw new Error("saved verdict differs from evidence");
  const metricName = record.policy.gate.metric ?? record.policy.metric;
  if (record.mode !== "calibration-aa") throw new Error("pilot requires A/A evidence");
  for (const kind of ["lineage", "tasks", "reports", "conditions"] as const) {
    const checks = verdict.checks.filter((c) => c.kind === kind);
    if (!checks.length || checks.some((c) => c.status !== "pass"))
      throw new Error(`incompatible pilot ${kind}`);
  }
  const { manifest, selected } = validateSplit(split);
  const choice = record.evidence.selections.find((s) => s.set === "gate");
  if (!choice) throw new Error("explicit A/A report selections are required");
  const pilot = verdict.inputs.taskSets.find((s) => s.set === "gate");
  if (!pilot || pilot.excluded.length) throw new Error("pilot tasks must not be excluded");
  const sides = [choice.parent, choice.child].map((ref) => {
    const job = record.evidence.jobs.find((j) => j.id === ref.job);
    const report = record.evidence.reports.find(
      (r) => r.jobId === ref.job && r.revision === ref.revision,
    );
    const method = report?.methods.find((m) => m.method === ref.method);
    if (!job || !report || !method || !["done", "cancelled"].includes(job.state))
      throw new Error("pilot jobs must be finished");
    const metric = resolveMetrics(job.metrics).find((m) => m.name === metricName);
    if (metric?.range?.[0] !== 0 || metric.range[1] !== 100)
      throw new Error("pilot metric must declare a bounded 0..100 range");
    if (job.spec.seeds !== 1 || job.spec.samplePlan || job.spec.batchSize)
      throw new Error("pilot requires one bounded score sample per task in each independent job");
    if (
      job.spec.benchmark !== manifest.benchmark.registration ||
      gateBenchmark(job) !== manifest.benchmark.identity.id
    )
      throw new Error("pilot and frozen benchmark differ");
    const identity = job.benchmarkSnapshot?.labels?.identity ?? job.capabilities?.identity;
    const source = job.source ? { commit: job.source.commit, dirty: job.source.dirty } : null;
    if (
      (identity?.version ?? null) !== manifest.benchmark.identity.version ||
      (identity?.variant ?? null) !== manifest.benchmark.identity.variant ||
      JSON.stringify(source) !== JSON.stringify(manifest.benchmark.source)
    )
      throw new Error("pilot and frozen source version differ");
    if (job.spec.tasks.some((t) => !selected.evolve.has(t)))
      throw new Error("pilot exposed held-out or unknown tasks");
    if (job.spec.tasks.length !== pilot.total) throw new Error("pilot task count differs");
    if (new Set(method.entries.map((e) => e.task)).size !== method.entries.length)
      throw new Error("repeated tasks are not independent units");
    if (
      method.entries.some(
        (e) => e.evaluation === "valid" && (e.value === null || e.value < 0 || e.value > 100),
      )
    )
      throw new Error("pilot score must be within 0..100");
    return { job, report, method };
  });
  const left = sides[0];
  const right = sides[1];
  if (!left || !right) throw new Error("two A/A sides are required");
  const other = new Map(right.method.entries.map((e) => [e.sample, e]));
  const pairs = left.method.entries.flatMap((a) => {
    const b = other.get(a.sample);
    return a.evaluation === "valid" && b?.evaluation === "valid"
      ? [{ a: a.value, b: b.value }]
      : [];
  });
  const flips = pairs.filter((p) => p.a !== p.b).length;
  const upper = flipUpper(flips, pairs.length);
  const entries = sides.flatMap((s) => s.method.entries);
  const snapshots = runSnapshots.map((r) => Run.parse(r));
  if (new Set(snapshots.map((r) => r.id)).size !== snapshots.length)
    throw new Error("duplicate Run snapshots");
  const byRun = new Map(snapshots.map((r) => [r.id, r]));
  let supplementedRuns = 0;
  const rows = sides
    .flatMap((s) => s.method.costs ?? [])
    .map((row) => {
      const snapshot = byRun.get(row.run);
      if (!snapshot) return row;
      if (!isTerminal(snapshot.state) || snapshot.cleanup !== "done")
        throw new Error("cost snapshot must be finalized");
      const cost = reportRunCost(snapshot);
      const needsTokens = !row.tokens || row.tokens.input === null || row.tokens.output === null;
      if (row.wallSeconds === null || needsTokens) supplementedRuns++;
      return {
        ...row,
        wallSeconds: row.wallSeconds ?? cost.wallSeconds,
        tokens: needsTokens ? (cost.tokens ?? row.tokens) : row.tokens,
      };
    });
  if (new Set(rows.map((r) => r.run)).size !== rows.length)
    throw new Error("shared or duplicate solve cost rows");
  const tasks = new Set(entries.map((e) => e.task));
  if (rows.some((r) => r.tasks.length !== 1 || r.tasks.some((t) => !tasks.has(t))))
    throw new Error("cost rows must identify one declared pilot task");
  const costsByRun = new Map(rows.map((r) => [r.run, r]));
  if (
    entries.some(
      (e) =>
        e.solveRunId &&
        costsByRun.has(e.solveRunId) &&
        !costsByRun.get(e.solveRunId)?.tasks.includes(e.task),
    )
  )
    throw new Error("cost row and solve task differ");
  const runs = new Set(rows.map((r) => r.run));
  const covered = entries.every((e) => e.solveRunId && runs.has(e.solveRunId));
  const wall = rows.filter((r) => r.complete && r.wallSeconds !== null);
  const tokens = rows.filter(
    (r) =>
      r.complete &&
      r.tokens?.input !== null &&
      r.tokens?.input !== undefined &&
      r.tokens?.output !== null &&
      r.tokens?.output !== undefined,
  );
  const wallKnown = wall.reduce((n, r) => n + (r.wallSeconds ?? 0), 0);
  const tokensKnown = tokens.reduce(
    (n, r) => n + (r.tokens?.input ?? 0) + (r.tokens?.output ?? 0),
    0,
  );
  const wallComplete = covered && rows.length > 0 && wall.length === rows.length;
  const tokenComplete = covered && rows.length > 0 && tokens.length === rows.length;
  const needed =
    upper === null
      ? null
      : {
          improvement: requiredTasks(upper, settings.effectPoints, settings.alpha, settings.power),
          guard: requiredTasks(upper, settings.marginPoints, settings.alpha, settings.power),
        };
  const invalid = entries.filter((e) => e.evaluation === "invalid").length;
  return {
    benchmark: manifest.benchmark.registration,
    metric: metricName,
    identity: manifest.benchmark.identity,
    record: record.id,
    revision: record.verdict.inputs.parent,
    reports: [choice.parent, choice.child],
    settings: { ...settings, round: 1, roundAlpha: alphaAt(1, settings.alpha) },
    population: {
      total: manifest.population.count,
      evolve: selected.evolve.size,
      gate: selected.gate.size,
      final: selected.final.size,
    },
    observations: {
      plannedTrials: entries.length,
      pairedTasks: pairs.length,
      pairedCoverage: pairs.length / pilot.total,
      flips,
      flipRate: pairs.length ? flips / pairs.length : null,
      flipUpper95: upper,
      invalid,
      invalidRate: invalid / entries.length,
      unresolved: entries.filter((e) => e.evaluation !== "valid" && e.evaluation !== "invalid")
        .length,
      prerequisiteCoveragePassed: verdict.checks
        .filter((c) => c.required && c.prerequisite)
        .every((c) => c.status === "pass"),
    },
    costs: {
      scope:
        "All saved solve Run intervals, including invalid attempts and any setup/service/cleanup within the interval; excludes verify and work outside saved solve intervals",
      solveRuns: rows.length,
      supplementedRuns,
      source: supplementedRuns
        ? "immutable reports plus explicit finalized Run snapshots for missing costs"
        : "immutable reports",
      wall: {
        knownRuns: wall.length,
        complete: wallComplete,
        knownSeconds: wallKnown,
        meanSecondsPerTrial: wallComplete ? wallKnown / entries.length : null,
      },
      tokens: {
        knownRuns: tokens.length,
        complete: tokenComplete,
        knownInputPlusOutput: tokensKnown,
        meanPerTrial: tokenComplete ? tokensKnown / entries.length : null,
      },
    },
    sizing:
      needed === null
        ? null
        : {
            method:
              "Normal approximation using one-sided 95% Wilson flip upper bound as bounded-difference variance; minimum 30 tasks",
            requiredPairedTasks: needed,
            gateFitsImprovement: needed.improvement <= selected.gate.size,
            gateFitsGuard: needed.guard <= selected.gate.size,
            oneSideSolveSeconds: wallComplete
              ? {
                  improvement: (needed.improvement * wallKnown) / entries.length,
                  guard: (needed.guard * wallKnown) / entries.length,
                }
              : null,
            oneSideTokens: tokenComplete
              ? {
                  improvement: (needed.improvement * tokensKnown) / entries.length,
                  guard: (needed.guard * tokensKnown) / entries.length,
                }
              : null,
          },
    limitation:
      "A/A measures repeat noise on sampled evolve tasks, not future bundle disagreement, improvement, family-wide power or adaptive guarantees. Missing costs stay unknown; small or correlated task families can remain insufficient. No finite-population correction or multiplication of tasks by repeats.",
  };
}

function read(file: string, max = 32 * 1024 * 1024) {
  if (!statSync(file).isFile() || statSync(file).size > max)
    throw new Error("input is not a bounded regular file");
  return readFileSync(file, "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      aa: { type: "string", multiple: true },
      runs: { type: "string" },
      split: { type: "string", multiple: true },
      effect: { type: "string", default: "5" },
      margin: { type: "string", default: "5" },
      alpha: { type: "string", default: "0.05" },
      power: { type: "string", default: "0.8" },
    },
  });
  if (!values.aa?.length || values.aa.length !== values.split?.length)
    throw new Error("pair each --aa RECORD.json with --split DIRECTORY in the same order");
  const snapshots: Run[] = values.runs ? JSON.parse(read(values.runs)) : [];
  if (!Array.isArray(snapshots)) throw new Error("--runs requires a JSON array of exported Runs");
  const reports = values.aa.map((file, i) => {
    const dir = values.split?.[i];
    if (!dir) throw new Error("missing split directory");
    return summarizePilot(
      GateRecord.parse(JSON.parse(read(file))),
      {
        manifest: BenchSplitManifest.parse(JSON.parse(read(join(dir, "split.json"), 1024 * 1024))),
        content: Object.fromEntries(
          parts.map((p) => [p, read(join(dir, `${p}.txt`), 8 * 1024 * 1024)]),
        ) as Record<Partition, string>,
      },
      {
        effectPoints: Number(values.effect),
        marginPoints: Number(values.margin),
        alpha: Number(values.alpha),
        power: Number(values.power),
      },
      snapshots,
    );
  });
  if (new Set(reports.map((r) => r.identity.id)).size !== reports.length)
    throw new Error("use distinct benchmark families");
  console.log(
    JSON.stringify(
      { version: 1, purpose: "V0 pilot sizing, not an evolution verdict", families: reports },
      null,
      2,
    ),
  );
}
