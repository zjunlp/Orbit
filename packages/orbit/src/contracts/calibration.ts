// Calibration of a benchmark integration (design §9.14, §9.15): which tasks and methods to run,
// what to expect of them, and the judgement of a finished calibration job. Pure functions shared
// by the daemon (which runs calibration jobs) and the CLI.
import {
  type BenchCapabilities,
  type BenchJob,
  type BenchTask,
  type CalibrationCheck,
  type CalibrationReport,
  calibrationDefaults,
  capabilityAllows,
  type Trial,
  taskSuite,
} from "./bench.ts";
import { benchCategory } from "./categories.ts";
import { sampleLabel } from "./naming.ts";

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

/** Expectations: the benchmark's declaration over its category's defaults. */
export function expectations(caps: BenchCapabilities | undefined) {
  return { ...calibrationDefaults(benchCategory(caps)), ...caps?.calibration };
}

type Expect = ReturnType<typeof expectations>;
const inRange = (v: number | null | undefined, r: { min: number; max: number }) =>
  v != null && v >= r.min && v <= r.max;

export interface JudgeOptions {
  /** Why no rescore took place (or why it was partial). */
  rescoreNote?: string;
  expect?: Expect;
  /** Tasks whose reference solution is partial or missing: their oracle trials are not judged. */
  noOracle?: ReadonlySet<string>;
}

/**
 * Judge calibration trials: every trial valid, empty and oracle as expected, repeated seeds
 * agreeing, cleanup confirmed and, for trials rescored from saved evidence (an earlier scoring in
 * `history`), the first scoring reproduced.
 */
export function judgeCalibration(t: Trial[], o: JudgeOptions = {}): CalibrationCheck[] {
  const expect = o.expect ?? expectations(undefined);
  const noOracle = o.noOracle ?? new Set<string>();
  const label = (x: Trial) => `${x.task}/${x.method}#${sampleLabel(x)}`;
  const list = (xs: string[]) =>
    xs.length > 5 ? `${xs.slice(0, 5).join(", ")} +${xs.length - 5}` : xs.join(", ");
  const check = (
    name: string,
    bad: { trial: Trial; text: string }[],
    ok: string,
    scope = t.length,
  ): CalibrationCheck =>
    scope === 0
      ? { name, result: "not_run", detail: "no trials of this kind", trials: [] }
      : bad.length
        ? {
            name,
            result: "failed",
            detail: `${bad.length}/${scope}: ${list(bad.map((b) => b.text))}`,
            trials: bad.map((b) => b.trial.id),
          }
        : { name, result: "passed", detail: ok, trials: [] };
  const notExpected = (name: string, why: string): CalibrationCheck => ({
    name,
    result: "not_run",
    detail: why,
    trials: [],
  });
  const failing = (pred: (x: Trial) => boolean, text = label) =>
    t.filter((x) => !pred(x)).map((x) => ({ trial: x, text: text(x) }));
  const score = (x: Trial) => `${x.task}#${sampleLabel(x)}=${x.outcome?.score ?? "null"}`;
  const checks: CalibrationCheck[] = [
    check(
      "all trials finished",
      failing((x) => x.state === "done" && x.outcome !== null),
      `${t.length} trials`,
    ),
    check(
      "evaluation valid",
      failing(
        (x) => x.outcome?.evaluation === "valid",
        (x) => `${label(x)} (${x.outcome?.failure ?? x.outcome?.evaluation ?? "no outcome"})`,
      ),
      "every trial produced a trusted score",
    ),
  ];
  const empty = t.filter((x) => x.method === "empty");
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
            .filter((x) => (e === "min" ? x.outcome?.score !== 0 : !inRange(x.outcome?.score, e)))
            .map((x) => ({ trial: x, text: score(x) })),
          e === "min" ? "a policy that does nothing gets 0" : "within the declared range",
          empty.length,
        ),
  );
  const oracle = t.filter((x) => x.method === "oracle" && !noOracle.has(x.task));
  const r0 = expect.oracle;
  checks.push(
    r0 === "none"
      ? notExpected("oracle score", "the benchmark has no reference solution")
      : check(
          r0 === "max" ? "oracle scores the maximum" : `oracle scores ${r0.min}–${r0.max}`,
          oracle
            .filter((x) =>
              r0 === "max"
                ? x.outcome?.score == null || x.outcome.score !== x.outcome.maxScore
                : !inRange(x.outcome?.score, r0),
            )
            .map((x) => ({ trial: x, text: score(x) })),
          r0 === "max" ? "the reference solution gets full marks" : "within the declared range",
          oracle.length,
        ),
  );
  const groups = new Map<string, Trial[]>();
  for (const x of t)
    groups.set(`${x.sampleRef ?? x.task}/${x.method}`, [
      ...(groups.get(`${x.sampleRef ?? x.task}/${x.method}`) ?? []),
      x,
    ]);
  const repeated = [...groups].filter(([, v]) => v.length > 1);
  const r = expect.repeat;
  const values = (v: Trial[]) => v.map((x) => x.outcome?.score ?? null);
  const spread = (v: (number | null)[]) =>
    v.some((x) => x === null)
      ? Number.POSITIVE_INFINITY
      : Math.max(...(v as number[])) - Math.min(...(v as number[]));
  const disagree = repeated.filter(([, v]) =>
    r === "exact" ? new Set(values(v)).size > 1 : spread(values(v)) > r.tolerance,
  );
  checks.push(
    expect.seedsVary
      ? notExpected("repeated seeds agree", "seeds select different episodes (initial states)")
      : repeated.length === 0
        ? notExpected(
            r === "exact" ? "repeated seeds agree" : `repeated seeds within ${r.tolerance}`,
            "no task × method was repeated",
          )
        : disagree.length
          ? {
              name: r === "exact" ? "repeated seeds agree" : `repeated seeds within ${r.tolerance}`,
              result: "failed",
              detail: `${disagree.length}/${repeated.length}: ${list(disagree.map(([k, v]) => `${k}: ${values(v).join("/")}`))}`,
              trials: disagree.flatMap(([, v]) => v.map((x) => x.id)),
            }
          : {
              name: r === "exact" ? "repeated seeds agree" : `repeated seeds within ${r.tolerance}`,
              result: "passed",
              detail: `${repeated.length} task × method pairs`,
              trials: [],
            },
  );
  checks.push(
    check(
      "cleanup confirmed",
      failing((x) => x.outcome?.cleanup === "done"),
      "containers, networks and volumes removed; leases released",
    ),
  );
  const note = o.rescoreNote ? ` (${o.rescoreNote})` : "";
  const again = t.filter((x) => x.history.length > 0);
  if (!again.length)
    checks.push(notExpected("rescore reproduces scores", o.rescoreNote ?? "no trial was rescored"));
  else
    checks.push(
      check(
        "rescore reproduces scores",
        again
          .filter(
            (x) =>
              x.outcome?.evaluation !== "valid" ||
              (x.history[0]?.outcome.score ?? null) !== (x.outcome?.score ?? null),
          )
          .map((x) => ({ trial: x, text: label(x) })),
        `saved evidence gives the same scores for ${again.length}/${t.length} trial(s)${note}`,
        again.length,
      ),
    );
  return checks;
}

/** The report of a calibration job (`spec.calibration`), or null for other jobs. */
export function calibrationReport(job: BenchJob, trials: Trial[]): CalibrationReport | null {
  const c = job.spec.calibration;
  if (!c) return null;
  // Cleanup is confirmed after the outcome; a pending one is not judged yet.
  const open = trials.some((x) => x.state !== "done" || x.outcome?.cleanup === "pending");
  const phase =
    job.state === "running" || (open && !job.rescore)
      ? "running"
      : job.rescore?.state === "started" || open
        ? "rescoring"
        : "done";
  const checks = judgeCalibration(trials, {
    ...(job.rescore?.note
      ? { rescoreNote: job.rescore.note }
      : !c.rescore
        ? { rescoreNote: "disabled" }
        : {}),
    expect: expectations(job.capabilities),
    noOracle: new Set(c.noOracle),
  });
  return {
    benchmark: job.spec.benchmark,
    job: job.id,
    tasks: [...new Set(job.spec.tasks)],
    methods: job.spec.methods.map((m) => m.name),
    seeds: job.spec.seeds ?? 1,
    phase,
    checks,
    calibrated:
      phase === "done" &&
      checks.every((x) => x.result !== "failed") &&
      checks.some((x) => x.result === "passed"),
    createdAt: job.createdAt,
    endedAt: phase === "done" ? job.endedAt : null,
    source: job.source ? { commit: job.source.commit, dirty: job.source.dirty } : null,
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
