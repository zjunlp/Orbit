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
  trialRunIds,
} from "./bench.ts";
import { benchCategory } from "./categories.ts";
import { sampleLabel } from "./naming.ts";
import { isTerminal, type Run } from "./runs.ts";

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

/** Includes historical and unlinked owned Runs; missing references must be represented by null. */
export function calibrationRunsClean(runs: ReadonlyMap<string, Run | null>): boolean {
  return [...runs.values()].every(
    (run) =>
      run !== null &&
      isTerminal(run.state) &&
      run.cleanup === "done" &&
      (!run.lease || run.lease.state === "released"),
  );
}

/** Completion of the scored work from execution timestamps, never from delayed cleanup. */
export function calibrationExecutionEnd(
  job: BenchJob,
  trials: Trial[],
  runs: ReadonlyMap<string, Run | null>,
): string | null {
  if (job.spec.calibration?.mode !== "policy") return null;
  if (job.calibrationExecutionEndedAt) return job.calibrationExecutionEndedAt;
  if (
    job.state === "running" ||
    !trials.length ||
    trials.some((t) => t.state !== "done") ||
    [...runs.values()].some((run) => !run || !isTerminal(run.state))
  )
    return null;
  const rescoreSettled =
    job.state === "cancelled" ||
    !job.spec.calibration.rescore ||
    job.capabilities?.rescore === "none" ||
    job.rescore?.state === "done" ||
    (job.rescore?.state === "started" && Boolean(job.rescore.note || trials[0]?.history.length));
  if (!rescoreSettled) return null;
  const ends = [...trials.map((t) => t.endedAt), ...[...runs.values()].map((r) => r?.endedAt)];
  if (ends.some((end) => !end || !Number.isFinite(Date.parse(end)))) return null;
  return new Date(Math.max(...ends.map((end) => Date.parse(end as string)))).toISOString();
}

/** The report of a calibration job (`spec.calibration`), or null for other jobs. */
export function calibrationReport(
  job: BenchJob,
  trials: Trial[],
  runs?: ReadonlyMap<string, Run | null>,
): CalibrationReport | null {
  const c = job.spec.calibration;
  if (!c) return null;
  const relatedRuns = new Map([
    ...trials.flatMap(trialRunIds).map((id) => [id, runs?.get(id) ?? null] as const),
    ...(runs ?? []),
  ]);
  const clean = c.mode !== "policy" || calibrationRunsClean(relatedRuns);
  const executionEndedAt = calibrationExecutionEnd(job, trials, relatedRuns);
  // Cleanup is confirmed after the outcome; a pending one is not judged yet.
  const open = !clean || trials.some((x) => x.state !== "done" || x.outcome?.cleanup === "pending");
  const phase =
    c.mode === "policy"
      ? job.state === "running"
        ? "running"
        : open || !job.calibrationExecutionEndedAt || !job.endedAt
          ? "rescoring"
          : "done"
      : job.state === "running" || (open && !job.rescore)
        ? "running"
        : job.rescore?.state === "started" || open
          ? "rescoring"
          : "done";
  let checks = judgeCalibration(trials, {
    ...(job.rescore?.note
      ? { rescoreNote: job.rescore.note }
      : !c.rescore
        ? { rescoreNote: "disabled" }
        : {}),
    expect: expectations(job.capabilities),
    noOracle: new Set(c.noOracle),
  });
  const deadlineAt =
    c.mode === "policy"
      ? new Date(Date.parse(job.createdAt) + (c.budgetMin as number) * 60_000).toISOString()
      : undefined;
  if (c.mode === "policy") {
    checks = checks.filter((check) =>
      ["all trials finished", "evaluation valid", "rescore reproduces scores"].includes(check.name),
    );
    const add = (name: string, ok: boolean, detail: string, pending = false) =>
      checks.push({
        name,
        result:
          pending ||
          (!ok && phase !== "done" && !job.calibrationExpiredAt && job.state !== "cancelled")
            ? "not_run"
            : ok
              ? "passed"
              : "failed",
        detail,
        trials: [],
      });
    add(
      "cleanup confirmed",
      clean,
      clean
        ? "all owned solve and verification Runs, including scoring history, cleaned; leases released"
        : "waiting for all owned Runs, including scoring history and unlinked submissions, to finish cleanup and release leases",
      !clean,
    );
    add(
      "acceptance budget",
      !job.calibrationExpiredAt &&
        job.state !== "cancelled" &&
        Boolean(
          executionEndedAt && Date.parse(executionEndedAt) <= Date.parse(deadlineAt as string),
        ),
      job.calibrationExpiredAt
        ? `total budget exhausted at ${job.calibrationExpiredAt}; unfinished checks did not pass`
        : job.state === "cancelled"
          ? "integration check cancelled"
          : `${c.budgetMin} minute wall-clock budget, including queue, model startup, verification and rescore`,
      !executionEndedAt && !job.calibrationExpiredAt && job.state !== "cancelled",
    );
    const method = job.spec.methods[0];
    add(
      "frozen model and samples",
      method?.policySnapshot?.kind === "model" &&
        Boolean(job.spec.samplePlan) &&
        trials.length === job.spec.samplePlan?.items.length &&
        new Set(trials.map((t) => t.sampleRef)).size === trials.length &&
        trials.every((t) =>
          job.spec.samplePlan?.items.some((s) => s.sampleId === t.sampleRef && s.taskId === t.task),
        ),
      "real registered model and 2–5 explicit frozen samples; native success is not an integration threshold",
    );
    const shared = trials.some((t) => (t.batch?.plan.members.length ?? 0) > 1);
    add(
      "fixed batch execution",
      shared &&
        trials.every((t) => {
          const batch = t.batch;
          const solve = t.solveRunId ? runs?.get(t.solveRunId) : null;
          return (
            batch &&
            batch.plan.members[batch.index]?.sampleRef === t.sampleRef &&
            solve &&
            solve.state === "succeeded" &&
            solve.spec.tags.batch_attempt === batch.plan.attemptId &&
            solve.spec.params.batchDigest === batch.plan.digest &&
            solve.spec.services.filter((s) => s.name === "policy").length === 1 &&
            trials
              .filter((peer) => peer.batch?.plan.id === batch.plan.id)
              .every((peer) => peer.solveRunId === solve.id)
          );
        }),
      "fixed membership shares a solve Run and model service; per-episode random-stream reset is not implied",
    );
    const verificationIds = [
      ...new Set(
        trials
          .flatMap((t) => [t.verifyRunId, ...t.history.map((h) => h.verifyRunId)])
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    add(
      "independent CPU verification",
      verificationIds.length >= trials.length &&
        verificationIds.every((id) => {
          const run = runs?.get(id);
          return (
            run?.state === "succeeded" &&
            run.spec.resources.gpus === 0 &&
            run.spec.services.length === 0 &&
            trials.every((t) => t.solveRunId !== id)
          );
        }),
      "saved episode evidence verified without loading a model or simulator",
    );
    if (c.rescore) {
      const again = trials.filter((t) => t.history.length > 0);
      add(
        "requested rescore completed",
        again.length > 0 &&
          again.every(
            (t) =>
              t.history.at(-1)?.outcome.evaluation === "valid" &&
              t.outcome?.evaluation === "valid" &&
              t.history.at(-1)?.outcome.score === t.outcome.score &&
              t.history.at(-1)?.outcome.maxScore === t.outcome.maxScore &&
              t.history.at(-1)?.verifyRunId !== t.verifyRunId,
          ),
        "selected episode rescored from the original solve; trusted verdict preserved",
      );
    }
  }
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
      (c.mode !== "policy" ||
        checks
          .filter((x) => c.rescore || x.name !== "rescore reproduces scores")
          .every((x) => x.result === "passed")) &&
      checks.some((x) => x.result === "passed"),
    ...(c.mode === "policy"
      ? {
          mode: "policy" as const,
          policyRef: job.spec.methods[0]?.policyRef,
          samples: job.spec.samplePlan?.items.length,
          budget: {
            minutes: c.budgetMin as number,
            deadlineAt: deadlineAt as string,
            ...(executionEndedAt ? { executionEndedAt } : {}),
            ...(job.calibrationExpiredAt ? { expiredAt: job.calibrationExpiredAt } : {}),
          },
        }
      : {}),
    createdAt: job.createdAt,
    endedAt: phase === "done" ? job.endedAt : null,
    source: job.source ? { commit: job.source.commit, dirty: job.source.dirty } : null,
  };
}

export function formatCalibration(r: CalibrationReport): string {
  const mark = { passed: "PASS", failed: "FAIL", not_run: "n/a " } as const;
  return [
    `${r.benchmark}: ${r.mode === "policy" ? (r.calibrated ? "policy integration passed" : "policy integration NOT passed") : r.calibrated ? "calibrated" : "NOT calibrated"} (job ${r.job})`,
    `tasks: ${r.tasks.join(", ")}`,
    r.mode === "policy"
      ? `policy: ${r.policyRef}; ${r.samples} frozen episodes; ${r.budget?.minutes} minute total budget`
      : `methods: ${r.methods.join(", ")} × ${r.seeds} seed(s)`,
    ...(r.mode === "policy"
      ? [
          "Scope: sampled model path; benchmark semantic calibration and full-suite statistical equivalence remain separate.",
        ]
      : []),
    "",
    ...r.checks.map((x) => `${mark[x.result]}  ${x.name}: ${x.detail}`),
  ].join("\n");
}
