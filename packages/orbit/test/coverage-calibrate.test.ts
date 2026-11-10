// biome-ignore-all lint/suspicious/noTemplateCurlyInString: compose interpolation fixtures
// Pure coverage and calibration judgement over explicit task and trial fixtures.
import { expect, it } from "vitest";
import {
  type BenchJob,
  benchCoverage,
  calibrationMethods,
  calibrationReport,
  expectations,
  judgeCalibration,
  normalizeReason,
  sampleTasks,
  type Trial,
} from "../src/contracts/index.ts";

const task = (id: string, suite: string | null, reason: string | null = null) => ({
  id,
  title: null,
  supported: reason === null,
  reason,
  tags: (suite ? { suite } : {}) as Record<string, string>,
});

it("counts coverage by suite and by normalized reason", () => {
  const c = benchCoverage([
    task("a1", "a"),
    task(
      "a2",
      "a",
      "compose service sim: volume ${DATA:?set DATA to the dataset}:/d:ro is not supported",
    ),
    task(
      "b1",
      "b",
      "compose service other: volume ${DATA:?help}:/d:ro is not supported; [[steps]] (multi-step tasks) is not supported",
    ),
    task("miniwob.click", null),
  ]);
  expect(c).toMatchObject({ total: 4, supported: 2 });
  expect(c.suites.map((s) => [s.suite, s.supported, s.total])).toEqual([
    ["a", 1, 2],
    ["b", 0, 1],
    ["miniwob", 1, 1],
  ]);
  expect(c.reasons[0]).toEqual({
    reason: "compose service <service>: volume ${DATA}:/d:ro is not supported",
    tasks: 2,
    suites: ["a", "b"],
  });
  expect(normalizeReason("compose service main: x is not supported")).toBe(
    "compose service main: x is not supported",
  );
});

it("samples supported tasks round robin over suites", () => {
  const ts = [task("a1", "a"), task("a2", "a"), task("a3", "a", "no"), task("b1", "b")];
  expect(sampleTasks(ts, 3)).toEqual(["a1", "b1", "a2"]);
  expect(sampleTasks(ts, 5, "a")).toEqual(["a1", "a2"]);
});

it("uses only the calibration methods a benchmark admits", () => {
  const caps = (methods: string[]) => ({
    kind: "other" as const,
    methods,
    conditions: {},
    scoreKind: "binary" as const,
    rescore: "evidence" as const,
    requires: [],
    profiles: [],
    domains: [],
  });
  expect(calibrationMethods(undefined, true)).toEqual(["empty", "oracle"]);
  expect(calibrationMethods(caps(["external", "empty"]), true)).toEqual(["empty"]);
  expect(calibrationMethods(caps(["empty", "oracle"]), false)).toEqual(["empty"]);
});

const trial = (taskId: string, method: string, seed: number, score: number | null, over = {}) => ({
  id: `${taskId}-${method}-${seed}`,
  jobId: "j",
  task: taskId,
  method,
  seed,
  state: "done",
  solveRunId: "s",
  verifyRunId: "v",
  issues: [],
  outcome: {
    execution: "succeeded",
    evaluation: "valid",
    score,
    maxScore: 1,
    issues: [],
    cleanup: "done",
    review: null,
    ...over,
  },
  history: [],
  createdAt: "",
  endedAt: "",
});
const detail = (trials: unknown[]) => trials as Trial[];

it("passes a well-behaved integration and names what fails", () => {
  const good = detail([
    trial("t", "empty", 1, 0),
    trial("t", "empty", 2, 0),
    trial("t", "oracle", 1, 1),
    trial("t", "oracle", 2, 1),
  ]);
  // A rescore keeps the first scoring in history; the same score again reproduces it.
  const again = good.map((x) => ({
    ...x,
    history: [{ verifyRunId: "v0", outcome: x.outcome, endedAt: "" }],
  }));
  const checks = judgeCalibration(again as Trial[]);
  expect(checks.every((c) => c.result === "passed")).toBe(true);
  // Without any rescored trial the check is not run and says why.
  const skipped = judgeCalibration(good, { rescoreNote: "4 trial(s) not rescored" }).pop();
  expect(skipped).toMatchObject({ result: "not_run", detail: "4 trial(s) not rescored" });
  // A rescore that changes a score fails and names the trial.
  const changed = again.map((x, i) =>
    i === 0 ? { ...x, outcome: { ...x.outcome, score: 1 } } : x,
  );
  const rescore = judgeCalibration(changed as Trial[]).pop();
  expect(rescore).toMatchObject({ result: "failed", trials: ["t-empty-1"] });

  const bad = detail([
    trial("t", "empty", 1, 0),
    trial("t", "empty", 2, 1),
    trial("t", "oracle", 1, null, { evaluation: "invalid", failure: "infra" }),
    trial("t", "oracle", 2, 1, { cleanup: "failed" }),
  ]);
  const by = Object.fromEntries(
    judgeCalibration(bad, { rescoreNote: "skipped" }).map((c) => [c.name, c]),
  );
  expect(by["evaluation valid"]?.detail).toContain("t/oracle#1 (infra)");
  expect(by["empty scores the minimum"]?.result).toBe("failed");
  expect(by["oracle scores the maximum"]?.result).toBe("failed");
  expect(by["repeated seeds agree"]?.result).toBe("failed");
  expect(by["cleanup confirmed"]?.result).toBe("failed");
  expect(by["rescore reproduces scores"]?.result).toBe("not_run");
});

it("judges against the category's and benchmark's expectations", async () => {
  const runs = detail([
    trial("t", "empty", 1, 1),
    trial("t", "empty", 2, 0),
    trial("t", "oracle", 1, 1),
  ]);
  const by = (exp: ReturnType<typeof expectations>) =>
    Object.fromEntries(judgeCalibration(runs, { expect: exp }).map((c) => [c.name, c.result]));
  // Embodied policy: a still policy may succeed, and seeds are different initial states.
  const policy = by(expectations({ category: "embodied-policy" } as never));
  expect(policy["empty score"]).toBe("not_run");
  expect(policy["repeated seeds agree"]).toBe("not_run");
  // Workspace default: empty must be 0, seeds must agree.
  const ws = by(expectations({ category: "agent-workspace" } as never));
  expect(ws["empty scores the minimum"]).toBe("failed");
  expect(ws["repeated seeds agree"]).toBe("failed");
  // A benchmark may widen it (StrongReject-style: an empty answer is safe, score 1).
  const declared = by(
    expectations({
      category: "fixed-input",
      calibration: { empty: { min: 0, max: 1 }, repeat: { tolerance: 1 } },
    } as never),
  );
  expect(declared["empty scores 0–1"]).toBe("passed");
  expect(declared["repeated seeds within 1"]).toBe("passed");
});

it("samples tasks with a full reference first and does not judge oracle-less tasks", () => {
  const ts = [
    { ...task("a1", "a"), tags: { suite: "a", oracle: "none" } },
    { ...task("a2", "a"), tags: { suite: "a", oracle: "full" } },
  ];
  expect(sampleTasks(ts, 1, undefined, true)).toEqual(["a2"]);
  expect(sampleTasks(ts, 1)).toEqual(["a1"]);
  const checks = judgeCalibration(detail([trial("a1", "oracle", 1, 0)]), {
    noOracle: new Set(["a1"]),
  });
  expect(checks.find((c) => c.name === "oracle scores the maximum")?.result).toBe("not_run");
});

it("reports a calibration job by phase and only calls a finished one calibrated", () => {
  const trials = detail([trial("t", "empty", 1, 0), trial("t", "oracle", 1, 1)]);
  const job = {
    id: "j",
    spec: {
      benchmark: "b",
      tasks: ["t"],
      methods: [{ name: "empty" }, { name: "oracle" }],
      seeds: 1,
      calibration: { noOracle: [], rescore: true },
    },
    state: "done",
    source: null,
    createdAt: "c",
    endedAt: "e",
  } as unknown as BenchJob;
  // Ended, the rescore not started yet / in progress / finished.
  expect(calibrationReport(job, trials)?.phase).toBe("done");
  expect(calibrationReport({ ...job, rescore: { state: "started" } }, trials)).toMatchObject({
    phase: "rescoring",
    calibrated: false,
  });
  const done = calibrationReport({ ...job, rescore: { state: "done", note: "x" } }, trials);
  expect(done).toMatchObject({ phase: "done", calibrated: true, endedAt: "e" });
  expect(done?.checks.at(-1)).toMatchObject({ result: "not_run", detail: "x" });
  expect(calibrationReport({ ...job, state: "running" }, trials)?.phase).toBe("running");
  // A trial whose cleanup is still being confirmed is not judged yet.
  const pending = trials.map((x, i) =>
    i ? x : { ...x, outcome: { ...x.outcome, cleanup: "pending" } },
  );
  expect(
    calibrationReport({ ...job, rescore: { state: "done" } }, pending as Trial[])?.phase,
  ).not.toBe("done");
  expect(
    calibrationReport({ ...job, spec: { ...job.spec, calibration: undefined } }, trials),
  ).toBeNull();
});
