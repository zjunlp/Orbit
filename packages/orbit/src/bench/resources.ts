// A benchmark's resources file (design §7): per-task solve resources that override what the adapter
// asks for, written by people (or their Agent) from evidence, and checked against measured use with
// `orbit bench usage`, which only suggests changes.
import { readFileSync } from "node:fs";
import {
  type BenchJobDetail,
  BenchResources,
  type BenchUsageRow,
  isAgentMethod,
  isTerminal,
  type ResourceOverride,
  type Run,
  type RunSpecInput,
  type Trial,
} from "../contracts/index.ts";
import { tokenUsage } from "../sessions/tokens.ts";
import { timedOut } from "./classify.ts";

/** Read and validate a resources file; errors name the file and the offending field. */
export function loadResources(file: string): BenchResources {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`resources file ${file}: ${(e as Error).message}`);
  }
  const r = BenchResources.safeParse(raw);
  if (!r.success)
    throw new Error(
      `resources file ${file}: ${r.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; ")}`,
    );
  return r.data;
}

const FIELDS = ["cpus", "memGB", "gpus", "gpuMemGB", "timeoutMin"] as const;

/** The overrides for one task: its entry over `default`, without the human-only fields. */
export function taskOverride(r: BenchResources, task: string): ResourceOverride {
  const out: ResourceOverride = {};
  for (const src of [r.default, r.tasks[task] ?? {}])
    for (const k of FIELDS) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

/** Overrides for the given tasks; task ids in the file that the benchmark does not list are errors. */
export function resolveResources(
  r: BenchResources,
  tasks: string[],
  known: string[],
): Record<string, ResourceOverride> {
  const unknown = Object.keys(r.tasks).filter((t) => !known.includes(t));
  if (unknown.length) throw new Error(`resources file names unknown tasks: ${unknown.join(", ")}`);
  return Object.fromEntries(tasks.map((t) => [t, taskOverride(r, t)]));
}

/** Apply overrides to a solve run; `--timeout` given at submit stays in charge of the timeout. */
export function applyOverride(
  spec: RunSpecInput,
  o: ResourceOverride | undefined,
  timeoutMin?: number,
): RunSpecInput {
  const { timeoutMin: taskTimeout, ...res } = o ?? {};
  return {
    ...spec,
    resources: { ...spec.resources, ...res },
    timeoutMin: timeoutMin ?? taskTimeout ?? spec.timeoutMin,
  };
}

// ---- suggestions from measured use ----

const MEM_STEPS = [2, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256];
const CPU_STEPS = [1, 2, 4, 8, 16, 32, 64];
/** Headroom over the largest measured peak (Autopilot-style: peak plus a safety margin). */
const MARGIN = 1.2;

const step = (steps: number[], v: number) => steps.find((s) => s >= v) ?? Math.ceil(v);
const roundHour = (min: number) => Math.ceil(min / 60) * 60;
const max = (xs: (number | null | undefined)[]) => {
  let largest: number | null = null;
  for (const x of xs)
    if (typeof x === "number") largest = largest === null ? x : Math.max(largest, x);
  return largest;
};

const sharedSolve = (r: Run) => Number(r.spec.tags?.batch_size ?? 1) > 1;
const durationMinutes = (r: Run) =>
  r.startedAt && r.endedAt ? (Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 60_000 : null;

/**
 * Measured solve use of one task over its runs, and the resource fields worth changing: memory and
 * GPU memory from peak × 1.2 rounded up to a step (raised after an OOM), CPUs from the peak, the
 * timeout from the longest standalone episode × 1.5 rounded to hours (raised after a timeout); memory is lowered
 * only from two or more runs. GPUs are never suggested: whether a task needs one is a decision
 * about the task, not a measurement.
 */
export function usageRow(
  task: string,
  requested: ResourceOverride,
  runs: Run[],
  sharedRunIds?: ReadonlySet<string>,
): BenchUsageRow {
  const measured = runs.filter((r) => r.usage);
  const maxMinutes = max(runs.map(durationMinutes));
  const timeouts = runs.filter(timedOut);
  const hasSharedSolve = runs.some((r) => sharedSolve(r) || sharedRunIds?.has(r.id));
  const row: BenchUsageRow = {
    task,
    runs: measured.length,
    requested,
    peakMemGB: max(measured.map((r) => r.usage?.peakMemGB)),
    peakGpuMemGB: max(measured.map((r) => r.usage?.peakGpuMemGB)),
    peakCpus: max(measured.map((r) => r.usage?.peakCpus)),
    meanCpus: max(measured.map((r) => r.usage?.meanCpus)),
    maxMinutes: maxMinutes === null ? null : Math.round(maxMinutes * 10) / 10,
    oomKilled: measured.filter((r) => r.usage?.oomKilled).length,
    oomKills: measured.filter((r) => (r.usage?.oomKills ?? 0) > 0).length,
    timeouts: timeouts.length,
    suggest: {},
    notes: [],
    tokenUsage: tokenUsage(runs),
  };
  if (hasSharedSolve)
    row.notes.push(
      "shared solve timings cover the entire batch; per-episode timeout advice unavailable",
    );
  if (measured.length === 0) {
    row.notes.push("no measured runs");
    return row;
  }
  const memReq = requested.memGB;
  if (row.peakMemGB !== null && memReq !== undefined) {
    let want = step(MEM_STEPS, row.peakMemGB * MARGIN);
    if (row.oomKilled || row.oomKills) {
      want = Math.max(want, step(MEM_STEPS, memReq + 0.01));
      row.notes.push(`killed for memory in ${row.oomKilled || row.oomKills} run(s)`);
    }
    if (want > memReq) row.suggest.memGB = want;
    // Lowering needs several runs and room to spare, so one quiet run does not shrink a request.
    else if (measured.length >= 2 && want <= memReq / 2) row.suggest.memGB = want;
  }
  if (row.peakGpuMemGB !== null && requested.gpuMemGB !== undefined) {
    const want = step(MEM_STEPS, row.peakGpuMemGB * MARGIN);
    if (want > requested.gpuMemGB) row.suggest.gpuMemGB = want;
  }
  if (requested.gpus && row.peakGpuMemGB !== null && row.peakGpuMemGB < 0.3)
    row.notes.push("GPU leased but hardly used; check whether the task needs one");
  if (row.peakCpus !== null && requested.cpus !== undefined) {
    const want = step(CPU_STEPS, row.peakCpus);
    if (want > requested.cpus) row.suggest.cpus = want;
  }
  const timeoutMin = requested.timeoutMin;
  if (row.timeouts) row.notes.push(`timed out in ${row.timeouts} run(s)`);
  if (!hasSharedSolve && maxMinutes !== null && timeoutMin !== undefined) {
    let want = roundHour((Math.round(maxMinutes * 10) / 10) * 1.5);
    if (row.timeouts) want = Math.max(want, roundHour(timeoutMin * 1.5));
    if (want > timeoutMin) row.suggest.timeoutMin = want;
  }
  if (measured.length < 3) row.notes.push(`only ${measured.length} run(s) measured`);
  return row;
}

export function usageRows(
  jobs: BenchJobDetail[],
  getRun: (id: string) => Run | null,
): BenchUsageRow[] {
  const runs = new Map<string, Run[]>();
  const requested = new Map<string, Run["spec"]>();
  const sharedRunIds = new Set<string>();
  for (const d of jobs) {
    // Only Agent methods show what a task needs; oracle and empty runs say nothing about it.
    const agents = new Set(d.job.spec.methods.filter(isAgentMethod).map((m) => m.name));
    for (const t of d.trials) {
      if (!agents.has(t.method)) continue;
      for (const { solveRunId: id, batch } of [...(t.priorAttempts ?? []), t]) {
        const r = id ? getRun(id) : null;
        if (!r || !isTerminal(r.state)) continue;
        if (batch && batch.plan.members.length > 1) sharedRunIds.add(r.id);
        const own = runs.get(t.task) ?? [];
        if (!own.some((run) => run.id === r.id)) runs.set(t.task, [...own, r]);
        // The latest job's current request is what a suggestion is compared against.
        requested.set(t.task, r.spec);
      }
    }
  }
  return [...runs.keys()].sort().map((task) => {
    const s = requested.get(task) as Run["spec"];
    const { cpus, memGB, gpus, gpuMemGB } = s.resources;
    const row = usageRow(
      task,
      { cpus, memGB, gpus, ...(gpuMemGB ? { gpuMemGB } : {}), timeoutMin: s.timeoutMin },
      runs.get(task) ?? [],
      sharedRunIds,
    );
    return row;
  });
}

/** Selected and prior solve attempts, shared batch runs counted once. */
export function solveRuns(trials: Trial[], getRun: (id: string) => Run | null): Run[] {
  const ids = new Set(
    trials
      .flatMap((t) => [t.solveRunId, ...(t.priorAttempts ?? []).map((a) => a.solveRunId)])
      .filter((id): id is string => Boolean(id)),
  );
  return [...ids].flatMap((id) => {
    const run = getRun(id);
    return run ? [run] : [];
  });
}
