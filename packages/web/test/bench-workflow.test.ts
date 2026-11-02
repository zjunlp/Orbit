import { describe, expect, it } from "vitest";
import { compareJobs } from "../../orbit/src/bench/summary.ts";
import { BenchJob, Trial } from "../../orbit/src/contracts/index.ts";
import {
  comparisonChange,
  conditionDifferences,
  jobConditions,
  matchesTrial,
  withBaseline,
} from "../src/pages/bench/conditions.ts";

const job = (id = "fixture") =>
  BenchJob.parse({
    id,
    spec: {
      benchmark: "fixture",
      tasks: ["a", "b"],
      methods: [
        { name: "baseline", agent: "empty" },
        { name: "candidate", agent: "empty" },
      ],
    },
    resources: null,
    source: null,
    state: "done",
    createdAt: "2026-11-02T00:00:00Z",
    endedAt: null,
    capabilities: {
      kind: "browser",
      methods: ["empty"],
      conditions: { Observation: "Screenshot" },
      scoreKind: "binary",
      rescore: "evidence",
    },
    benchmarkSnapshot: {
      name: "fixture",
      adapter: "/fixture/adapter",
      path: "/fixture/tasks",
      config: { mode: "coord", steps: "20" },
      createdAt: "",
      updatedAt: "",
    },
  });
function trial(task: string, method: string, score: number, evaluation = "valid") {
  return Trial.parse({
    id: `${task}.${method}`,
    jobId: "fixture",
    task,
    method,
    seed: 1,
    state: "done",
    solveRunId: null,
    verifyRunId: null,
    issues: [],
    outcome: {
      score,
      maxScore: 1,
      evaluation,
      execution: "succeeded",
      cleanup: "done",
      issues: [],
    },
    createdAt: "",
    endedAt: "",
  });
}

describe("GUI evaluation workflow", () => {
  it("separates valid task failure from invalid evidence and scalar scores", () => {
    const j = job(),
      zero = trial("a", "baseline", 0),
      invalid = trial("a", "candidate", 0, "invalid");
    expect(matchesTrial(zero, j, "unfinished")).toBe(true);
    expect(matchesTrial(zero, j, "issues")).toBe(false);
    expect(matchesTrial(invalid, j, "unfinished")).toBe(false);
    expect(matchesTrial(invalid, j, "issues")).toBe(true);
    if (j.capabilities) j.capabilities.scoreKind = "scalar";
    expect(matchesTrial(zero, j, "unfinished")).toBe(false);
    expect(matchesTrial({ ...zero, state: "verifying", outcome: null }, j, "active")).toBe(true);
  });
  it("uses saved conditions, treats missing legacy settings as unknown, and ignores object key order", () => {
    const a = job(),
      b = job("other");
    if (b.benchmarkSnapshot) b.benchmarkSnapshot.config = { steps: "20", mode: "coord" };
    expect(conditionDifferences([a, b])).toEqual([]);
    if (b.benchmarkSnapshot) b.benchmarkSnapshot.config.mode = "bid";
    expect(conditionDifferences([a, b])).toContain("Environment settings");
    delete b.benchmarkSnapshot;
    expect(jobConditions(b)["Environment settings"]).toBe("Not recorded");
    b.spec.seeds = 2;
    expect(conditionDifferences([a, b])).toContain("Repetitions");
  });
  it("changes baseline using the same paired difference calculation and retains coverage", () => {
    const c = compareJobs([
      {
        job: job(),
        trials: [
          trial("a", "baseline", 0),
          trial("a", "candidate", 1),
          trial("b", "baseline", 1),
          trial("b", "candidate", 1),
        ],
      },
    ]);
    expect(c.stats.score?.columns.candidate?.diff?.mean).toBe(50);
    const rebased = withBaseline(c, "candidate");
    expect(rebased.columns[0]?.key).toBe("candidate");
    expect(rebased.stats.score?.columns.baseline?.diff?.mean).toBe(-50);
    expect(rebased.stats.score?.columns.candidate?.diff).toBeNull();
    expect(rebased.stats.score?.pairedTasks).toBe(2);
    expect(rebased.stats.score?.columns.baseline?.all).toEqual(
      c.stats.score?.columns.baseline?.all,
    );
    expect(withBaseline(c, "missing")).toBe(c);
  });
  it("filters differences according to metric direction without treating missing results as zero", () => {
    expect(comparisonChange(0, 1, true)).toBe("improved");
    expect(comparisonChange(0, 1, false)).toBe("regressed");
    expect(comparisonChange(0, 0, true)).toBe("unchanged");
    expect(comparisonChange(null, 0, true)).toBe("unavailable");
  });
});
