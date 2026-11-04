// `orbit bench calibrate`: run the calibration methods on a sample of a benchmark's tasks and judge
// whether the integration behaves (design §9.14). It only uses the public client API; the job and
// its trials stay in Orbit like any other job.
import type { OrbitClient } from "../client/index.ts";
import {
  type BenchCapabilities,
  type BenchJobDetail,
  type BenchTask,
  capabilityAllows,
  taskSuite,
} from "../contracts/index.ts";

export type CheckResult = "passed" | "failed" | "not_run";
export interface CalibrationCheck {
  name: string;
  result: CheckResult;
  detail: string;
}
export interface CalibrationReport {
  benchmark: string;
  job: string;
  tasks: string[];
  methods: string[];
  seeds: number;
  checks: CalibrationCheck[];
  /** Every check passed (`not_run` checks do not count against it, but are listed). */
  calibrated: boolean;
}

/** Spread `n` tasks over the suites, round robin, in each suite's listed order. */
export function sampleTasks(tasks: BenchTask[], n: number, suite?: string): string[] {
  const bySuite = new Map<string, string[]>();
  for (const t of tasks) {
    if (!t.supported) continue;
    const s = taskSuite(t);
    if (suite && s !== suite) continue;
    bySuite.set(s, [...(bySuite.get(s) ?? []), t.id]);
  }
  const queues = [...bySuite.values()];
  const out: string[] = [];
  for (let i = 0; out.length < n && queues.some((q) => q.length > i); i++)
    for (const q of queues) if (q[i] && out.length < n) out.push(q[i] as string);
  return out;
}

/** Calibration methods the benchmark admits: `empty` always when allowed, `oracle` when allowed. */
export function calibrationMethods(caps: BenchCapabilities | undefined, oracle: boolean): string[] {
  const allowed = (m: string) => !caps || capabilityAllows(caps.methods, m);
  return ["empty", ...(oracle ? ["oracle"] : [])].filter(allowed);
}

/**
 * Judge a finished calibration job: every trial valid, empty at the minimum and oracle at the
 * maximum score, repeated seeds agreeing, cleanup confirmed and (optionally) a rescore from saved
 * evidence reproducing every score.
 */
export function judgeCalibration(
  d: BenchJobDetail,
  rescored: BenchJobDetail | null,
  rescoreNote?: string,
): CalibrationCheck[] {
  const t = d.trials;
  const outcome = (x: (typeof t)[number]) => x.outcome;
  const list = (xs: string[]) =>
    xs.length > 5 ? `${xs.slice(0, 5).join(", ")} +${xs.length - 5}` : xs.join(", ");
  const failing = (pred: (x: (typeof t)[number]) => boolean) =>
    t.filter((x) => !pred(x)).map((x) => `${x.task}/${x.method}#${x.seed}`);
  const check = (name: string, bad: string[], ok: string, scope = t.length): CalibrationCheck =>
    scope === 0
      ? { name, result: "not_run", detail: "no trials of this kind" }
      : bad.length
        ? { name, result: "failed", detail: `${bad.length}/${scope}: ${list(bad)}` }
        : { name, result: "passed", detail: ok };
  const checks: CalibrationCheck[] = [];
  checks.push(
    check(
      "all trials finished",
      failing((x) => x.state === "done" && outcome(x) !== null),
      `${t.length} trials`,
    ),
  );
  checks.push(
    check(
      "evaluation valid",
      failing((x) => outcome(x)?.evaluation === "valid").map((k) => {
        const x = t.find((y) => `${y.task}/${y.method}#${y.seed}` === k);
        return `${k} (${x?.outcome?.failure ?? x?.outcome?.evaluation ?? "no outcome"})`;
      }),
      "every trial produced a trusted score",
    ),
  );
  const empty = t.filter((x) => x.method === "empty");
  checks.push(
    check(
      "empty scores the minimum",
      empty
        .filter((x) => outcome(x)?.score !== 0)
        .map((x) => `${x.task}#${x.seed}=${x.outcome?.score ?? "null"}`),
      "a policy that does nothing gets 0",
      empty.length,
    ),
  );
  const oracle = t.filter((x) => x.method === "oracle");
  checks.push(
    check(
      "oracle scores the maximum",
      oracle
        .filter((x) => outcome(x)?.score == null || outcome(x)?.score !== outcome(x)?.maxScore)
        .map((x) => `${x.task}#${x.seed}=${x.outcome?.score ?? "null"}`),
      "the reference solution gets full marks",
      oracle.length,
    ),
  );
  const groups = new Map<string, (number | null)[]>();
  for (const x of t) {
    const k = `${x.task}/${x.method}`;
    groups.set(k, [...(groups.get(k) ?? []), x.outcome?.score ?? null]);
  }
  const repeated = [...groups].filter(([, v]) => v.length > 1);
  checks.push(
    check(
      "repeated seeds agree",
      repeated.filter(([, v]) => new Set(v).size > 1).map(([k, v]) => `${k}: ${v.join("/")}`),
      `${repeated.length} task × method pairs`,
      repeated.length,
    ),
  );
  checks.push(
    check(
      "cleanup confirmed",
      failing((x) => outcome(x)?.cleanup === "done"),
      "containers, networks and volumes removed; leases released",
    ),
  );
  if (!rescored)
    checks.push({
      name: "rescore reproduces scores",
      result: "not_run",
      detail: rescoreNote ?? "skipped",
    });
  else {
    const before = new Map(t.map((x) => [x.id, x.outcome?.score ?? null]));
    const bad = rescored.trials
      .filter(
        (x) => x.outcome?.evaluation !== "valid" || before.get(x.id) !== (x.outcome?.score ?? null),
      )
      .map((x) => `${x.task}/${x.method}#${x.seed}`);
    checks.push(
      check(
        "rescore reproduces scores",
        bad,
        "saved evidence gives the same scores",
        rescored.trials.length,
      ),
    );
  }
  return checks;
}

export interface CalibrateOptions {
  tasks?: string[];
  sample: number;
  suite?: string;
  seeds: number;
  oracle: boolean;
  rescore: boolean;
  timeoutMin?: number;
  waitMin: number;
  progress?: (text: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitJob(c: OrbitClient, id: string, deadline: number): Promise<BenchJobDetail> {
  for (;;) {
    const d = await c.benchJob(id);
    const settled = d.trials.every((x) => x.state === "done" && x.outcome?.cleanup !== "pending");
    if (d.trials.length && settled && d.job.state !== "running") return d;
    if (Date.now() > deadline) throw new Error(`calibration job ${id} did not finish in time`);
    await sleep(3000);
  }
}

export async function calibrate(
  c: OrbitClient,
  benchmark: string,
  o: CalibrateOptions,
): Promise<CalibrationReport> {
  const info = await c.benchInfo(benchmark);
  const tasks = o.tasks?.length ? o.tasks : sampleTasks(info.tasks, o.sample, o.suite);
  if (!tasks.length) throw new Error(`${benchmark} has no supported tasks to calibrate`);
  const methods = calibrationMethods(info.capabilities, o.oracle);
  if (!methods.length) throw new Error(`${benchmark} admits neither empty nor oracle`);
  const job = await c.benchSubmit({
    name: `calibrate ${benchmark}`,
    benchmark,
    tasks,
    methods: methods.map((m) => ({ name: m, agent: m })),
    seeds: o.seeds,
    ...(o.timeoutMin ? { timeoutMin: o.timeoutMin } : {}),
  });
  o.progress?.(
    `job ${job.id}: ${tasks.length} task(s) × ${methods.join(", ")} × ${o.seeds} seed(s)`,
  );
  const deadline = Date.now() + o.waitMin * 60_000;
  const done = await waitJob(c, job.id, deadline);
  let rescored: BenchJobDetail | null = null;
  let note: string | undefined;
  if (!o.rescore) note = "disabled (--no-rescore)";
  else if (info.capabilities && info.capabilities.rescore === "none")
    note = "the benchmark declares no rescore";
  else {
    o.progress?.("rescoring from saved evidence");
    try {
      const r = await c.benchRescore(job.id, {});
      if (r.skipped.length) note = `${r.skipped.length} trial(s) not rescored`;
      rescored = await waitJob(c, job.id, deadline);
    } catch (e) {
      note = `rescore refused: ${(e as Error).message}`;
    }
  }
  const checks = judgeCalibration(done, rescored, note);
  return {
    benchmark,
    job: job.id,
    tasks,
    methods,
    seeds: o.seeds,
    checks,
    calibrated:
      checks.every((x) => x.result !== "failed") && checks.some((x) => x.result === "passed"),
  };
}

export function formatCalibration(r: CalibrationReport): string {
  const mark = { passed: "PASS", failed: "FAIL", not_run: "n/a " } as const;
  return [
    `${r.benchmark}: ${r.calibrated ? "calibrated" : "NOT calibrated"} (job ${r.job})`,
    `tasks: ${r.tasks.join(", ")}`,
    `methods: ${r.methods.join(", ")} × ${r.seeds} seed(s)`,
    "",
    ...r.checks.map((x) => `${mark[x.result]}  ${x.name}: ${x.detail}`),
  ].join("\n");
}
