// Pure coverage and calibration judgement over explicit task and trial fixtures.
import { expect, it } from "vitest";
import { calibrationMethods, judgeCalibration, sampleTasks } from "../src/cli/calibrate.ts";
import { type BenchJobDetail, benchCoverage, normalizeReason } from "../src/contracts/index.ts";

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
const detail = (trials: unknown[]) =>
  ({ job: {}, trials, summary: [] }) as unknown as BenchJobDetail;

it("passes a well-behaved integration and names what fails", () => {
  const good = detail([
    trial("t", "empty", 1, 0),
    trial("t", "empty", 2, 0),
    trial("t", "oracle", 1, 1),
    trial("t", "oracle", 2, 1),
  ]);
  const checks = judgeCalibration(good, good);
  expect(checks.every((c) => c.result === "passed")).toBe(true);

  const bad = detail([
    trial("t", "empty", 1, 0),
    trial("t", "empty", 2, 1),
    trial("t", "oracle", 1, null, { evaluation: "invalid", failure: "infra" }),
    trial("t", "oracle", 2, 1, { cleanup: "failed" }),
  ]);
  const by = Object.fromEntries(judgeCalibration(bad, null, "skipped").map((c) => [c.name, c]));
  expect(by["evaluation valid"]?.detail).toContain("t/oracle#1 (infra)");
  expect(by["empty scores the minimum"]?.result).toBe("failed");
  expect(by["oracle scores the maximum"]?.result).toBe("failed");
  expect(by["repeated seeds agree"]?.result).toBe("failed");
  expect(by["cleanup confirmed"]?.result).toBe("failed");
  expect(by["rescore reproduces scores"]?.result).toBe("not_run");
});
