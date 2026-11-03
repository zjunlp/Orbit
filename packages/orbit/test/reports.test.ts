import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { classify } from "../src/bench/classify.ts";
import {
  buildReport,
  officialValue,
  planDigest,
  sameReport,
  summarize,
} from "../src/bench/summary.ts";
import { orbitPaths } from "../src/config/paths.ts";
import {
  AdapterTasksResponse,
  BenchJob,
  OfficialRule,
  Outcome,
  type ReportEntry,
  Run,
  ScoreResult,
  Trial,
} from "../src/contracts/index.ts";
import { Store } from "../src/store/index.ts";

const home = mkdtempSync(join(tmpdir(), "orbit-reports-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const at = "2026-01-01T00:00:00Z";
const outcome = (evaluation: Outcome["evaluation"], score: number | null, extra = {}) =>
  Outcome.parse({
    execution: "succeeded",
    evaluation,
    score,
    maxScore: 1,
    issues: [],
    cleanup: "done",
    ...extra,
  });
const trial = (id: string, task: string, seed: number, o: Outcome | null, method = "m") =>
  Trial.parse({
    id,
    jobId: "job",
    task,
    method,
    seed,
    state: o ? "done" : "solving",
    solveRunId: `${id}-solve`,
    verifyRunId: null,
    outcome: o,
    createdAt: at,
    endedAt: o ? at : null,
  });
const job = (official?: object) =>
  BenchJob.parse({
    id: "job",
    spec: { benchmark: "b", tasks: ["a", "b"], methods: [{ name: "m", agent: "empty" }], seeds: 2 },
    ...(official ? { official } : {}),
    state: "done",
    createdAt: at,
    endedAt: at,
  });

describe("official aggregation", () => {
  const e = (
    task: string,
    evaluation: ReportEntry["evaluation"],
    value: number | null,
  ): ReportEntry => ({
    trial: `${task}-${evaluation}`,
    sample: `${task}#1`,
    task,
    seed: 1,
    solveRunId: null,
    verifyRunId: null,
    evaluation,
    value,
  });

  it("pools samples or averages tasks, and counts errors only when the rule says so", () => {
    // Two batches: 1/1 and 1/9 successes. Batch mean 55.6%, pooled episode rate 20%.
    const entries = [
      e("x", "valid", 100),
      ...Array.from({ length: 9 }, (_, i) => e("y", "valid", i === 0 ? 100 : 0)),
    ];
    const pooled = OfficialRule.parse({ name: "r", errors: "exclude", unit: "sample" });
    const byTask = OfficialRule.parse({ name: "r", errors: "exclude", unit: "task" });
    expect(officialValue(entries, pooled, "score").value).toBeCloseTo(20);
    expect(officialValue(entries, byTask, "score").value).toBeCloseTo(55.556, 2);
  });

  it("puts invalid samples in the denominator for `fail` and marks missing ones partial", () => {
    const entries = [
      e("x", "valid", 100),
      e("x", "valid", 100),
      e("x", "invalid", null),
      e("x", "pending", null),
    ];
    const fail = OfficialRule.parse({ name: "vla", errors: "fail", unit: "sample" });
    const exclude = OfficialRule.parse({ name: "r", errors: "exclude", unit: "sample" });
    expect(officialValue(entries, fail, "score")).toEqual({
      metric: "score",
      value: 200 / 3,
      samples: 3,
      missing: 1,
      partial: true,
    });
    expect(officialValue(entries, exclude, "score").value).toBe(100);
  });

  it("is declared by the adapter and appears next to Orbit's view in the summary", () => {
    const reply = AdapterTasksResponse.parse({
      tasks: [],
      official: { name: "vla-eval", version: "1", errors: "fail", unit: "sample" },
    });
    expect(reply.official?.failValue).toBe(0);
    const ts = [
      trial("1", "a", 1, outcome("valid", 1)),
      trial("2", "a", 2, outcome("invalid", null)),
    ];
    const [s] = summarize(["m"], ts, [], reply.official);
    expect(s?.metrics.score?.mean).toBe(100);
    expect(s?.official?.value).toBe(50);
    expect(summarize(["m"], ts)[0]?.official).toBeUndefined();
  });
});

describe("reports", () => {
  it("lists every planned sample with the attempt used, counts and both views", () => {
    const ts = [
      trial("1", "a", 1, outcome("valid", 1)),
      trial("2", "a", 2, outcome("invalid", null, { failure: "scorer_error" })),
      trial("3", "b", 1, outcome("unknown", null)),
      trial("4", "b", 2, null),
    ];
    const r = buildReport(
      job({ name: "o", errors: "fail", unit: "sample" }),
      ts,
      "finished",
      1,
      at,
    );
    const m = r.methods[0];
    expect(m).toMatchObject({
      planned: 4,
      completed: 3,
      valid: 1,
      invalid: 1,
      unknown: 1,
      missing: 2,
    });
    expect(m?.failures).toEqual({ scorer_error: 1 });
    expect(m?.entries.map((x) => [x.sample, x.evaluation, x.solveRunId])).toEqual([
      ["a#1", "valid", "1-solve"],
      ["a#2", "invalid", "2-solve"],
      ["b#1", "unknown", "3-solve"],
      ["b#2", "pending", "4-solve"],
    ]);
    expect(m?.orbit?.mean).toBe(100);
    expect(m?.official).toMatchObject({ value: 50, samples: 2, missing: 2, partial: true });
    expect(r.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes the plan digest when tasks or seeds are added, not when results change", () => {
    const a = job();
    expect(planDigest(a)).toBe(planDigest({ spec: { ...a.spec, tasks: ["b", "a"] } }));
    expect(planDigest(a)).not.toBe(planDigest({ spec: { ...a.spec, tasks: ["a", "b", "c"] } }));
    expect(planDigest(a)).not.toBe(planDigest({ spec: { ...a.spec, seeds: 3 } }));
  });

  it("stores revisions append-only and treats unchanged results as the same report", () => {
    const store = new Store(orbitPaths({ ORBIT_HOME: home }).db);
    const ts = [trial("1", "a", 1, outcome("valid", 1))];
    const r1 = buildReport(job(), ts, "finished", 1, at);
    store.addReport(r1);
    expect(() => store.addReport(r1)).toThrow();
    expect(sameReport(r1, buildReport(job(), ts, "rescore", 2, "later"))).toBe(true);
    const rescored = [trial("1", "a", 1, outcome("valid", 0))];
    const r2 = buildReport(job(), rescored, "rescore", 2, at);
    expect(sameReport(r1, r2)).toBe(false);
    store.addReport(r2);
    expect(
      store.reports("job").map((r) => [r.revision, r.reason, r.methods[0]?.orbit?.mean]),
    ).toEqual([
      [1, "finished", 100],
      [2, "rescore", 0],
    ]);
    store.deleteJob("job");
    expect(store.reports("job")).toEqual([]);
    store.close();
  });
});

describe("failure kinds", () => {
  const run = (over: object) =>
    Run.parse({
      id: "r",
      spec: { image: "img", command: ["x"] },
      state: "succeeded",
      reason: null,
      exitCode: 0,
      node: "n",
      image: "img",
      containerId: null,
      lease: null,
      code: null,
      cleanup: "done",
      note: "",
      createdAt: at,
      startedAt: at,
      endedAt: at,
      ...over,
    });

  it("records why a trial is invalid and keeps the adapter's kind and episode", () => {
    expect(classify(run({ startedAt: null, state: "failed" }), null, null).failure).toBe("infra");
    const verify = run({ id: "v" });
    const bad = ScoreResult.parse({
      score: null,
      invalid: true,
      failure: "judge_unavailable",
      episode: { steps: 12, truncated: true, endedBy: "step_limit" },
    });
    const o = classify(run({}), verify, bad);
    expect(o).toMatchObject({ evaluation: "invalid", failure: "judge_unavailable" });
    expect(o.episode).toEqual({ steps: 12, truncated: true, endedBy: "step_limit" });
    expect(classify(run({}), verify, ScoreResult.parse({ score: null })).failure).toBe(
      "scorer_error",
    );
    const ok = classify(run({}), verify, ScoreResult.parse({ score: 1, failure: "infra" }));
    expect(ok.evaluation).toBe("valid");
    expect(ok.failure).toBeUndefined();
    const oom = run({
      state: "failed",
      exitCode: 137,
      usage: {
        samples: 1,
        peakMemGB: 4,
        peakCpus: 1,
        meanCpus: 1,
        peakGpuMemGB: null,
        oomKills: 1,
        oomKilled: true,
      },
    });
    expect(classify(oom, verify, ScoreResult.parse({ score: 1 })).failure).toBe("budget_exceeded");
  });
});
