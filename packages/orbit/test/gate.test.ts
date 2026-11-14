// Synthetic immutable report fixtures; real report builder and gate core. No Agent or experiment is run.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gate } from "../src/bench/gate.ts";
import { revisionOf } from "../src/bench/revision.ts";
import { buildReport, planDigest } from "../src/bench/summary.ts";
import { splitTasks, taskSetDigest } from "../src/bench/task-sets.ts";
import {
  BenchJob,
  type BenchReport,
  BenchSplitRequest,
  type GateEvidence,
  GatePolicy,
  type MethodBasis,
  Outcome,
  ReportEntry,
  Run,
  Trial,
} from "../src/contracts/index.ts";
import {
  alphaAt,
  lowerBound,
  mcnemarExact,
  nonInferior,
  pairedDiff,
  upperBound,
} from "../src/contracts/metrics.ts";

const base: MethodBasis = {
  agent: "codex",
  model: "fixture-model",
  effort: "medium",
  authKind: "api-key",
  cliVersion: "1.0",
  bundleDigest: "a".repeat(64),
  entrypoint: null,
  config: null,
};
const parent = revisionOf(base);
const child = revisionOf({ ...base, bundleDigest: "b".repeat(64) });
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
function fixture(n = 60) {
  const evidence: GateEvidence = { jobs: [], reports: [], taskSets: [], selections: [] };
  const policy = GatePolicy.parse({
    version: 1,
    gate: { benchmark: "fixture", tasks: { file: "gate.txt", sha256: "a".repeat(64) } },
  });
  const pair = (
    set: string,
    benchmark = "fixture",
    a = Array(n).fill(50) as number[],
    b = Array(n).fill(65) as number[],
    agent = "codex",
  ) => {
    const tasks = Array.from({ length: a.length }, (_, i) => `${set}/${i}`);
    const file = `${set}.txt`;
    const content = `${tasks.join("\n")}\n`;
    const p = agent === "codex" ? parent : revisionOf({ ...parent.basis, agent });
    const c = agent === "codex" ? child : revisionOf({ ...child.basis, agent });
    const jobs = [p, c].map((revision, i) =>
      BenchJob.parse({
        id: `${set}-${i}`,
        spec: {
          benchmark,
          tasks,
          methods: [
            { name: "candidate", agent, auth: "fixture", model: "fixture-model", effort: "medium" },
          ],
          lineage: i ? { candidate: { parent: p.revision } } : {},
        },
        taskSet: taskSetDigest(tasks),
        taskFile: { sha256: sha(content) },
        revisions: { candidate: revision },
        benchmarkSnapshot: {
          name: benchmark,
          adapter: "harbor",
          path: `/fixture/${benchmark}`,
          config: {},
          env: {},
          passEnv: [],
          labels: { identity: { id: benchmark, name: benchmark, version: "1" } },
          createdAt: "",
          updatedAt: "",
        },
        source: { commit: "a".repeat(40), describe: null, dirty: false },
        state: "done",
        createdAt: `2026-11-14T00:0${i}:00Z`,
        endedAt: `2026-11-14T00:0${i}:00Z`,
      }),
    );
    const reports = jobs.map((job, i) => {
      const rows = tasks.map((task, k) =>
        Trial.parse({
          id: `${job.id}.${k}`,
          jobId: job.id,
          task,
          method: "candidate",
          seed: 1,
          state: "done",
          solveRunId: `${job.id}.${k}-solve`,
          verifyRunId: null,
          history: [],
          outcome: Outcome.parse({
            execution: "succeeded",
            evaluation: "valid",
            score: (i ? b : a)[k],
            maxScore: 100,
            issues: [],
            cleanup: "done",
          }),
          createdAt: job.createdAt,
          endedAt: job.endedAt,
        }),
      );
      return buildReport(job, rows, "finished", 1, job.createdAt, (id) =>
        Run.parse({
          id,
          spec: { backend: "process", command: ["true"] },
          state: "succeeded",
          reason: null,
          exitCode: 0,
          node: "fixture",
          image: null,
          containerId: null,
          lease: null,
          code: null,
          cleanup: "done",
          note: "",
          createdAt: job.createdAt,
          startedAt: "2026-11-14T00:00:00Z",
          endedAt: "2026-11-14T00:00:10Z",
          tokens: {
            input: 100,
            output: 20,
            cachedInput: 0,
            cacheWrite: 0,
            reasoning: 0,
            calls: 1,
            source: "session",
          },
        }),
      );
    });
    const jobA = jobs[0],
      jobB = jobs[1],
      reportA = reports[0],
      reportB = reports[1];
    assert(jobA && jobB && reportA && reportB);
    evidence.jobs.push(jobA, jobB);
    evidence.reports.push(reportA, reportB);
    evidence.taskSets.push({ file, content });
    evidence.selections.push({
      set,
      parent: { job: jobA.id, revision: 1, method: "candidate" },
      child: { job: jobB.id, revision: 1, method: "candidate" },
    });
    return {
      a: jobA,
      b: jobB,
      ra: reportA,
      rb: reportB,
      dataset: { benchmark, tasks: { file, sha256: sha(content) } },
      tasks,
    };
  };
  const target = pair("gate");
  policy.gate = target.dataset;
  const check = () => gate(parent.revision, child.revision, policy, evidence);
  return { evidence, policy, pair, target, check };
}
function method(report: BenchReport) {
  const m = report.methods[0];
  assert(m);
  return m;
}

describe("gate statistics", () => {
  it("matches independent SciPy one-sided t reference values", () => {
    for (const [df, alpha, critical] of [
      [1, 0.05, 6.313751514800938],
      [2, 0.025, 4.302652729696144],
      [29, 0.05, 1.6991270265334972],
      [299, 0.05, 1.649965767426309],
      [100000, 0.001, 3.0903138094272373],
    ]) {
      assert(df !== undefined && alpha !== undefined && critical !== undefined);
      const d = {
        mean: 0,
        se: 1,
        ci: [-999, 999] as [number, number],
        tasks: df + 1,
        trials: df + 1,
      };
      expect(lowerBound(d, alpha)).toBeCloseTo(-critical, 6);
      expect(upperBound(d, alpha)).toBeCloseTo(critical, 6);
    }
    expect(lowerBound({ mean: 1, se: null, ci: null, tasks: 1, trials: 1 }, 0.05)).toBeNull();
    expect(() => lowerBound(null, 0)).toThrow();
    expect(() => alphaAt(0, 0.05)).toThrow();
  });
  it("distinguishes non-inferiority, a proven regression and insufficient evidence", () => {
    const d = { mean: -2, se: 1, ci: null, tasks: 100, trials: 100 };
    expect(nonInferior(d, 5, 0.05)).toBe("pass");
    expect(nonInferior({ ...d, mean: -10 }, 5, 0.05)).toBe("fail");
    expect(nonInferior({ ...d, mean: -5 }, 5, 0.05)).toBe("insufficient");
    expect(nonInferior(null, 5, 0.05)).toBe("insufficient");
    expect(() => nonInferior(d, -1, 0.05)).toThrow();
    const total = Array.from({ length: 10000 }, (_, i) => alphaAt(i + 1, 0.05)).reduce(
      (a, b) => a + b,
      0,
    );
    expect(total).toBeLessThan(0.05);
    expect(total).toBeGreaterThan(0.04999);
  });
  it("matches exact McNemar tails and handles large discordant counts without underflow errors", () => {
    expect(mcnemarExact(10, 0).greater).toBeCloseTo(1 / 1024, 12);
    expect(mcnemarExact(8, 2).greater).toBeCloseTo(56 / 1024, 12);
    expect(mcnemarExact(8, 2).twoSided).toBeCloseTo(112 / 1024, 12);
    expect(mcnemarExact(2, 8).less).toBeCloseTo(56 / 1024, 12);
    expect(mcnemarExact(300, 200).greater).toBeCloseTo(4.470033271126644e-6, 13);
    expect(mcnemarExact(0, 0)).toEqual({ greater: 1, less: 1, twoSided: 1 });
    expect(mcnemarExact(1000, 1000).twoSided).toBeCloseTo(1, 10);
    expect(Number.isFinite(mcnemarExact(1000, 1).greater)).toBe(true);
    expect(() => mcnemarExact(-1, 0)).toThrow();
  });
});

describe("evolution gate core", () => {
  it("accepts improvement with frozen evidence, preserves inputs and emits auditable references", () => {
    const f = fixture();
    const before = JSON.stringify(f.evidence);
    const result = f.check();
    expect(result.decision).toBe("accept");
    expect(result.level).toBe("in-domain");
    expect(result.alpha).toEqual({ round: 1, level: alphaAt(1, 0.05) });
    expect(result.inputs.policyDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.inputs.reports).toHaveLength(2);
    expect(JSON.stringify(f.evidence)).toBe(before);
    expect(f.check()).toEqual(result);
    expect(
      gate(parent.revision, child.revision, f.policy, {
        ...f.evidence,
        jobs: [...f.evidence.jobs].reverse(),
        reports: [...f.evidence.reports].reverse(),
      }),
    ).toEqual(result);
  });
  it("keeps A/A inconclusive and rejects demonstrated harm or excessive cost", () => {
    const f = fixture();
    for (const e of method(f.target.rb).entries) e.value = 50;
    expect(f.check().decision).toBe("insufficient");
    for (const e of method(f.target.rb).entries) e.value = 20;
    expect(f.check().decision).toBe("reject");
    for (const e of method(f.target.rb).entries) e.value = 65;
    for (const c of method(f.target.rb).costs ?? []) c.wallSeconds = 30;
    expect(f.check().decision).toBe("reject");
  });
  it("checks every guard and only raises levels with optional second-Agent final evidence", () => {
    const f = fixture();
    const g = f.pair("guard:0", "other", Array(60).fill(60), Array(60).fill(60));
    f.policy.guard.push({ ...g.dataset, margin: 5 });
    expect(f.check()).toMatchObject({ decision: "accept", level: "cross-domain" });
    for (const e of method(g.rb).entries) e.value = 50;
    expect(f.check().decision).toBe("reject");
    for (const e of method(g.rb).entries) e.value = 55;
    expect(f.check().decision).toBe("insufficient");
    for (const e of method(g.rb).entries) e.value = 60;
    const last = f.pair(
      "final:0:claude-code",
      "held-out",
      Array(60).fill(20),
      Array(60).fill(40),
      "claude-code",
    );
    f.policy.final.push({ ...last.dataset, agents: ["claude-code"] });
    expect(f.check()).toMatchObject({ decision: "accept", level: "transferable" });
    for (const e of method(last.rb).entries) e.value = 0;
    expect(f.check()).toMatchObject({ decision: "accept", level: "cross-domain" });
  });
  it("fails stale metadata, changed task sets, invalid reports and insufficient coverage safely", () => {
    const f = fixture();
    f.target.a.source = { commit: "old", describe: null, dirty: false };
    expect(f.check().decision).toBe("insufficient");
    f.target.a.source = f.target.b.source;
    f.target.a.taskFile = { sha256: "f".repeat(64) };
    expect(f.check().decision).toBe("insufficient");
    f.target.a.taskFile = f.target.b.taskFile;
    f.target.ra.planDigest = "wrong";
    expect(f.check().decision).toBe("insufficient");
    f.target.ra.planDigest = planDigest(f.target.a);
    method(f.target.rb).entries.splice(0, 1);
    expect(f.check().decision).toBe("insufficient");
    const small = fixture(20);
    expect(small.check().decision).toBe("insufficient");
  });
  it("pairs the same sample IDs and never counts invalid or unknown evaluations as failures", () => {
    const f = fixture();
    const entries = method(f.target.rb).entries;
    for (const e of entries.slice(0, 5)) e.evaluation = "invalid";
    expect(f.check().decision).toBe("insufficient");
    f.policy.max_invalid_increase = 0.1;
    expect(f.check().decision).toBe("accept");
    for (const e of entries.slice(0, 10)) e.evaluation = "unknown";
    expect(f.check().decision).toBe("insufficient");
  });
  it("excludes informedBy references through ancestors and rejects missing or cyclic provenance", () => {
    const f = fixture();
    const leak = method(f.target.ra).entries[0];
    assert(leak);
    f.target.a.spec.lineage.candidate = { informedBy: [leak.trial] };
    const result = f.check();
    expect(result.decision).toBe("accept");
    expect(result.inputs.taskSets[0]?.excluded).toEqual([
      { task: leak.task, trial: leak.trial, revision: parent.revision },
    ]);
    expect(result.inputs.taskSets[0]?.eligible).toBe(59);
    f.target.a.spec.lineage.candidate = { informedBy: ["missing-trial"] };
    expect(f.check().decision).toBe("insufficient");
    f.target.a.spec.lineage.candidate = { informedBy: [], parent: child.revision };
    expect(f.check().decision).toBe("insufficient");
  });
  it("spends alpha across earlier sibling revisions and does not count rescoring twice", () => {
    const f = fixture();
    const prior = structuredClone(f.target.b);
    const previous = revisionOf({ ...base, bundleDigest: "c".repeat(64) });
    prior.id = "earlier-child";
    prior.createdAt = "2026-11-14T00:00:30Z";
    prior.revisions.candidate = previous;
    const report = structuredClone(f.target.rb);
    report.jobId = prior.id;
    report.createdAt = "2099-01-01T00:00:00Z";
    f.evidence.jobs.push(prior);
    f.evidence.reports.push(report, { ...report, revision: 2 });
    expect(f.check().alpha).toEqual({ round: 2, level: alphaAt(2, 0.05) });
    expect(f.check().inputs.priorChildren).toEqual([previous.revision]);
  });
  it("leaves missing tokens and missing costs unchecked, and deduplicates shared solve Runs", () => {
    const f = fixture();
    const m = method(f.target.rb);
    delete m.costs;
    expect(f.check().decision).toBe("insufficient");
    const g = fixture();
    for (const cost of method(g.target.rb).costs ?? []) cost.tokens = null;
    expect(
      g.check().checks.some((c) => c.kind === "token-cost" && c.status === "not_checked"),
    ).toBe(true);
    const h = fixture();
    const shared = method(h.target.rb);
    const first = shared.costs?.[0];
    assert(first?.tokens);
    shared.costs = [
      {
        ...first,
        tasks: h.target.tasks,
        wallSeconds: 600,
        tokens: { ...first.tokens, input: 6000, output: 1200 },
      },
    ];
    for (const e of shared.entries) e.solveRunId = first.run;
    expect(h.check().decision).toBe("accept");
    const leak = method(h.target.ra).entries[0];
    assert(leak);
    h.target.a.spec.lineage.candidate = { informedBy: [leak.trial] };
    expect(h.check().decision).toBe("insufficient");
  });
  it("does not pair different valid seeds of the same task", () => {
    const f = fixture();
    for (const [i, job] of [f.target.a, f.target.b].entries()) {
      job.spec.seeds = 2;
      const report = i ? f.target.rb : f.target.ra;
      const m = method(report);
      const added = m.entries.map((e) =>
        ReportEntry.parse({
          ...e,
          sampleRef: undefined,
          trial: `${e.trial}-2`,
          sample: `${e.task}#2`,
          seed: 2,
          evaluation: i ? ("valid" as const) : ("invalid" as const),
        }),
      );
      for (const e of m.entries) e.evaluation = i ? "invalid" : "valid";
      m.entries.push(...added);
      m.planned = m.entries.length;
      report.planDigest = planDigest(job);
    }
    expect(f.check().decision).toBe("insufficient");
    expect(f.check().checks.find((c) => c.kind === "coverage")?.parent).toBe(0);
  });
  it("keeps optional final lineage gaps from upgrading the verdict", () => {
    const f = fixture();
    const last = f.pair(
      "final:0:claude-code",
      "held-out",
      Array(60).fill(20),
      Array(60).fill(40),
      "claude-code",
    );
    f.policy.final.push({ ...last.dataset, agents: ["claude-code"] });
    last.a.spec.lineage.candidate = { informedBy: ["missing-final-trial"] };
    expect(f.check()).toMatchObject({ decision: "accept", level: "in-domain" });
    expect(
      f
        .check()
        .checks.some(
          (c) => c.set.startsWith("final:") && c.kind === "lineage" && c.status === "insufficient",
        ),
    ).toBe(true);
  });
  it("rejects duplicate evidence and incomplete known history without resetting the budget", () => {
    const f = fixture();
    f.evidence.reports.push(f.target.ra);
    expect(f.check().decision).toBe("insufficient");
    const g = fixture();
    delete g.target.a.revisions.candidate;
    expect(g.check().decision).toBe("insufficient");
  });
  it("uses E1 frozen benchmark identities when the adapter has no identity declaration", () => {
    const f = fixture();
    const ids = f.target.tasks.map((id) => ({
      id,
      title: null,
      supported: true,
      reason: null,
      tags: {},
    }));
    const split = splitTasks(
      ids,
      BenchSplitRequest.parse({ evolve: 0, gate: 1, final: 0, seed: 42, out: "/unused" }),
      {
        registration: "fixture",
        identity: { id: "derived-fixture", version: null, variant: null },
        source: { commit: "a".repeat(40), dirty: false },
        settingsSha256: "f".repeat(64),
      },
    );
    const snapshot = f.evidence.taskSets[0];
    assert(snapshot);
    snapshot.content = split.content.gate;
    f.policy.gate = {
      benchmark: "derived-fixture",
      tasks: { file: snapshot.file, sha256: split.manifest.files.gate.sha256 },
    };
    for (const job of [f.target.a, f.target.b]) {
      assert(job.benchmarkSnapshot);
      delete job.benchmarkSnapshot.labels;
      job.taskFile = {
        sha256: split.manifest.files.gate.sha256,
        frozen: { partition: "gate", manifest: split.manifest },
      };
    }
    expect(f.check().decision).toBe("accept");
  });
  it("orients lower-is-better metrics without reversing the meaning of improvement", () => {
    const f = fixture();
    f.policy.metric = "latency";
    for (const job of [f.target.a, f.target.b])
      job.metrics = [
        {
          name: "latency",
          label: "Latency",
          unit: "s",
          range: [0, 100],
          higherIsBetter: false,
          primary: true,
        },
      ];
    for (const report of [f.target.ra, f.target.rb]) report.metric = "latency";
    expect(f.check().decision).toBe("reject");
    for (const entry of method(f.target.rb).entries) entry.value = 30;
    expect(f.check().decision).toBe("accept");
  });
  it("distinguishes explicitly reported zero cost from missing cost", () => {
    const f = fixture();
    for (const report of [f.target.ra, f.target.rb])
      for (const row of method(report).costs ?? []) {
        row.wallSeconds = 0;
        if (row.tokens) {
          row.tokens.input = 0;
          row.tokens.output = 0;
        }
      }
    expect(f.check().decision).toBe("accept");
    const row = method(f.target.rb).costs?.[0];
    assert(row?.tokens);
    row.tokens.output = 1;
    expect(f.check().decision).toBe("reject");
    row.complete = false;
    expect(f.check().decision).toBe("insufficient");
  });
  it("emits exact diagnostics and task regressions for binary scores", () => {
    const f = fixture();
    const a = method(f.target.ra),
      b = method(f.target.rb);
    for (const [i, e] of a.entries.entries()) e.value = i < 10 ? 100 : 0;
    for (const [i, e] of b.entries.entries()) e.value = i >= 10 ? 100 : 0;
    const result = f.check();
    expect(result.regressions).toHaveLength(10);
    expect(result.checks.find((c) => c.kind === "improvement")?.mcnemar).toMatchObject({
      gains: 50,
      losses: 10,
    });
  });
});

function random(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sampledDiff(n: number, pd: number, delta: number, rng: () => number) {
  const a = new Map<string, { mean: number }>(),
    b = new Map<string, { mean: number }>();
  for (let i = 0; i < n; i++) {
    const r = rng();
    a.set(String(i), { mean: r < (pd + delta) / 2 ? 0 : r < pd ? 100 : 0 });
    b.set(String(i), { mean: r < (pd + delta) / 2 ? 100 : 0 });
  }
  return pairedDiff(a, b);
}
describe("synthetic gate calibration", () => {
  it("controls null acceptance and has the planned order of power for 300 paired tasks", () => {
    const rng = random(42);
    const runs = 2000;
    let nulls = 0,
      positive = 0;
    for (let i = 0; i < runs; i++) {
      if ((lowerBound(sampledDiff(300, 0.2, 0, rng), alphaAt(1, 0.05)) ?? -Infinity) > 0) nulls++;
      if ((lowerBound(sampledDiff(300, 0.1, 0.05, rng), alphaAt(1, 0.05)) ?? -Infinity) > 0)
        positive++;
    }
    expect(nulls / runs).toBeLessThanOrEqual(alphaAt(1, 0.05));
    expect(positive / runs).toBeGreaterThan(0.73);
    expect(positive / runs).toBeLessThan(0.9);
  });
  it("bounds repeated null acceptance across independently drawn rounds under one alpha budget", () => {
    const rng = random(1234);
    const runs = 1500;
    let accepted = 0;
    for (let i = 0; i < runs; i++) {
      let any = false;
      for (let round = 1; round <= 12; round++)
        if ((lowerBound(sampledDiff(300, 0.2, 0, rng), alphaAt(round, 0.05)) ?? -Infinity) > 0)
          any = true;
      if (any) accepted++;
    }
    expect(accepted / runs).toBeLessThanOrEqual(0.05);
  });
});
