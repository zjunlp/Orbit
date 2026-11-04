// `orbit bench calibrate`: run the calibration methods on a sample of a benchmark's tasks and judge
// whether the integration behaves (design §9.14). It only uses the public client API; the job and
// its trials stay in Orbit like any other job.
import type { OrbitClient } from "../client/index.ts";
import {
  type BenchCapabilities,
  type BenchJobDetail,
  type BenchTask,
  benchCategory,
  calibrationDefaults,
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

/**
 * Spread `n` tasks over the suites, round robin, in each suite's listed order. With `oracle`, tasks
 * whose reference solution is partial or missing (`oracle` tag) come last, so a positive calibration
 * is not judged on a task that has none.
 */
export function sampleTasks(
  tasks: BenchTask[],
  n: number,
  suite?: string,
  oracle = false,
): string[] {
  const bySuite = new Map<string, string[]>();
  const rank = (t: BenchTask) => (oracle && t.tags.oracle && t.tags.oracle !== "full" ? 1 : 0);
  for (const t of [...tasks].sort((a, b) => rank(a) - rank(b))) {
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
export function calibrationMethods(
  caps: Pick<BenchCapabilities, "methods" | "calibration"> | undefined,
  oracle: boolean,
): string[] {
  if (caps?.calibration?.oracle === "none") oracle = false;
  const allowed = (m: string) => !caps || capabilityAllows(caps.methods, m);
  return ["empty", ...(oracle ? ["oracle"] : [])].filter(allowed);
}

/**
 * Judge a finished calibration job: every trial valid, empty at the minimum and oracle at the
 * maximum score, repeated seeds agreeing, cleanup confirmed and (optionally) a rescore from saved
 * evidence reproducing every score.
 */
/** Expectations: the benchmark's declaration over its category's defaults. */
export function expectations(caps: BenchCapabilities | undefined) {
  return { ...calibrationDefaults(benchCategory(caps)), ...caps?.calibration };
}

type Expect = ReturnType<typeof expectations>;
const inRange = (v: number | null | undefined, r: { min: number; max: number }) =>
  v != null && v >= r.min && v <= r.max;

export function judgeCalibration(
  d: BenchJobDetail,
  rescored: BenchJobDetail | null,
  rescoreNote?: string,
  expect: Expect = expectations(undefined),
  /** Tasks whose reference solution is partial or missing: their oracle trials are not judged. */
  noOracle: ReadonlySet<string> = new Set(),
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
  const notExpected = (name: string, why: string): CalibrationCheck => ({
    name,
    result: "not_run",
    detail: why,
  });
  const e = expect.empty;
  checks.push(
    e === "any"
      ? notExpected(
          "empty score",
          "no expected score for doing nothing (category or benchmark rule)",
        )
      : check(
          e === "min" ? "empty scores the minimum" : `empty scores ${e.min}–${e.max}`,
          empty
            .filter((x) => (e === "min" ? outcome(x)?.score !== 0 : !inRange(outcome(x)?.score, e)))
            .map((x) => `${x.task}#${x.seed}=${x.outcome?.score ?? "null"}`),
          e === "min" ? "a policy that does nothing gets 0" : "within the declared range",
          empty.length,
        ),
  );
  const oracle = t.filter((x) => x.method === "oracle" && !noOracle.has(x.task));
  const o = expect.oracle;
  checks.push(
    o === "none"
      ? notExpected("oracle score", "the benchmark has no reference solution")
      : check(
          o === "max" ? "oracle scores the maximum" : `oracle scores ${o.min}–${o.max}`,
          oracle
            .filter((x) =>
              o === "max"
                ? outcome(x)?.score == null || outcome(x)?.score !== outcome(x)?.maxScore
                : !inRange(outcome(x)?.score, o),
            )
            .map((x) => `${x.task}#${x.seed}=${x.outcome?.score ?? "null"}`),
          o === "max" ? "the reference solution gets full marks" : "within the declared range",
          oracle.length,
        ),
  );
  const groups = new Map<string, (number | null)[]>();
  for (const x of t) {
    const k = `${x.task}/${x.method}`;
    groups.set(k, [...(groups.get(k) ?? []), x.outcome?.score ?? null]);
  }
  const repeated = [...groups].filter(([, v]) => v.length > 1);
  const r = expect.repeat;
  const spread = (v: (number | null)[]) =>
    v.some((x) => x === null)
      ? Number.POSITIVE_INFINITY
      : Math.max(...(v as number[])) - Math.min(...(v as number[]));
  checks.push(
    expect.seedsVary
      ? notExpected("repeated seeds agree", "seeds select different episodes (initial states)")
      : check(
          r === "exact" ? "repeated seeds agree" : `repeated seeds within ${r.tolerance}`,
          repeated
            .filter(([, v]) => (r === "exact" ? new Set(v).size > 1 : spread(v) > r.tolerance))
            .map(([k, v]) => `${k}: ${v.join("/")}`),
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
    // Only trials that were actually scored again count; skipped ones keep their old outcome.
    const again = rescored.trials.filter(
      (x) => x.history.length > (t.find((y) => y.id === x.id)?.history.length ?? 0),
    );
    const bad = again
      .filter(
        (x) => x.outcome?.evaluation !== "valid" || before.get(x.id) !== (x.outcome?.score ?? null),
      )
      .map((x) => `${x.task}/${x.method}#${x.seed}`);
    const note = rescoreNote ? ` (${rescoreNote})` : "";
    checks.push(
      again.length
        ? check(
            "rescore reproduces scores",
            bad,
            `saved evidence gives the same scores for ${again.length}/${t.length} trial(s)${note}`,
            again.length,
          )
        : {
            name: "rescore reproduces scores",
            result: "not_run",
            detail: `no trial was rescored${note}`,
          },
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
  const tasks = o.tasks?.length
    ? o.tasks
    : sampleTasks(
        info.tasks,
        o.sample,
        o.suite,
        o.oracle && info.capabilities?.calibration?.oracle !== "none",
      );
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
  const noOracle = new Set(
    info.tasks.filter((t) => t.tags.oracle && t.tags.oracle !== "full").map((t) => t.id),
  );
  const checks = judgeCalibration(done, rescored, note, expectations(info.capabilities), noOracle);
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
