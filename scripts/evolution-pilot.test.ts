import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { gate } from "../packages/orbit/src/bench/gate.ts";
import { fileSha256, taskSetDigest } from "../packages/orbit/src/bench/task-sets.ts";
import {
  BenchCapabilities,
  BenchSplitManifest,
  GateRecord,
  Run,
} from "../packages/orbit/src/contracts/index.ts";
import { fixture, parent } from "../packages/orbit/test/fixtures/gate.ts";
import { type FrozenSplit, flipUpper, requiredTasks, summarizePilot } from "./evolution-pilot.ts";

function setup() {
  const f = fixture(8);
  f.policy.min_paired_tasks = 2;
  f.target.b.revisions.candidate = parent;
  f.target.b.spec.lineage = {};
  for (const job of f.evidence.jobs)
    job.capabilities = BenchCapabilities.parse({
      scoreKind: "binary",
      methods: ["cli"],
      rescore: "evidence",
      conditions: {},
    });
  for (const report of f.evidence.reports)
    for (const entry of report.methods[0]?.entries ?? []) entry.value = 100;
  const content = {
    evolve: f.evidence.taskSets[0]?.content ?? "",
    gate: `${Array.from({ length: 10 }, (_, i) => `held-out/${i}`).join("\n")}\n`,
    final: "final/0\n",
  };
  const all = Object.values(content).flatMap((s) => s.trim().split("\n"));
  const split: FrozenSplit = {
    content,
    manifest: BenchSplitManifest.parse({
      version: 1,
      algorithm: "sha256-stratified-v1",
      benchmark: {
        registration: "fixture",
        identity: { id: "fixture", version: "1", variant: null },
        source: { commit: "a".repeat(40), dirty: false },
        settingsSha256: "a".repeat(64),
      },
      seed: 42,
      proportions: { evolve: 0.4, gate: 0.5, final: 0.1 },
      stratify: "suite",
      population: { count: all.length, taskSet: taskSetDigest(all), listingSha256: "b".repeat(64) },
      unsupported: 0,
      files: Object.fromEntries(
        Object.entries(content).map(([p, text]) => [
          p,
          {
            path: `${p}.txt`,
            sha256: fileSha256(text),
            taskSet: taskSetDigest(text.trim().split("\n")),
            count: text.trim().split("\n").length,
          },
        ]),
      ),
    }),
  };
  const record = () =>
    GateRecord.parse({
      id: "pilot",
      evaluator: "orbit-gate/1",
      mode: "calibration-aa",
      createdAt: "2026-11-17T00:00:00Z",
      policy: f.policy,
      evidence: f.evidence,
      verdict: gate(parent.revision, parent.revision, f.policy, f.evidence, "calibration-aa"),
    });
  return { ...f, split, record };
}

it("does not treat zero observed A/A flips as zero future sample requirements", () => {
  const f = setup();
  const report = summarizePilot(f.record(), f.split);
  expect(report.observations).toMatchObject({ pairedTasks: 8, flips: 0, flipRate: 0, invalid: 0 });
  expect(report.observations.flipUpper95).toBeCloseTo(0.2527, 3);
  expect(report.sizing?.requiredPairedTasks.guard).toBeGreaterThan(700);
  expect(report.sizing?.gateFitsGuard).toBe(false);
  expect(report.costs.wall.meanSecondsPerTrial).toBe(10);
  expect(report.costs.tokens.meanPerTrial).toBe(120);
});
it("measures paired binary flips and keeps invalid attempts in cost and validity denominators", () => {
  const f = setup();
  const entries = f.target.rb.methods[0]?.entries;
  assert(entries?.[0] && entries[1]);
  entries[0].value = 0;
  entries[1].evaluation = "invalid";
  entries[1].value = null;
  const report = summarizePilot(f.record(), f.split);
  expect(report.observations).toMatchObject({
    plannedTrials: 16,
    pairedTasks: 7,
    flips: 1,
    invalid: 1,
    invalidRate: 1 / 16,
  });
  expect(report.observations.prerequisiteCoveragePassed).toBe(false);
  expect(report.costs.tokens.meanPerTrial).toBe(120);
});
it("preserves unknown costs instead of substituting zero or a partial mean", () => {
  const f = setup();
  const row = f.target.rb.methods[0]?.costs?.[0];
  assert(row);
  row.tokens = null;
  row.wallSeconds = null;
  const report = summarizePilot(f.record(), f.split);
  expect(report.costs.tokens).toMatchObject({ complete: false, knownRuns: 15, meanPerTrial: null });
  expect(report.costs.wall).toMatchObject({ complete: false, meanSecondsPerTrial: null });
  expect(report.sizing?.oneSideTokens).toBeNull();
});
it("refuses altered evidence, mixed conditions, reused runs and held-out pilot tasks", () => {
  const f = setup();
  const altered = f.record();
  altered.verdict.decision = "accept";
  expect(() => summarizePilot(altered, f.split)).toThrow("differs from evidence");
  f.target.b.source = { commit: "b".repeat(40), describe: null, dirty: false };
  expect(() => summarizePilot(f.record(), f.split)).toThrow("conditions");
  const g = setup();
  const row = g.target.rb.methods[0]?.entries[0];
  assert(row);
  row.solveRunId = g.target.ra.methods[0]?.entries[0]?.solveRunId ?? null;
  expect(() => summarizePilot(g.record(), g.split)).toThrow("reports");
  const h = setup();
  [h.split.content.evolve, h.split.content.gate] = [h.split.content.gate, h.split.content.evolve];
  for (const p of ["evolve", "gate"] as const) {
    const text = h.split.content[p];
    const ids = text.trim().split("\n");
    const file = h.split.manifest.files[p];
    file.sha256 = fileSha256(text);
    file.taskSet = taskSetDigest(ids);
    file.count = ids.length;
  }
  expect(() => summarizePilot(h.record(), h.split)).toThrow("held-out");
});
it("rejects modified frozen files and requires finished, one-sample bounded evidence", () => {
  const f = setup();
  f.split.content.final += "changed\n";
  expect(() => summarizePilot(f.record(), f.split)).toThrow("changed frozen final");
  const g = setup();
  g.target.b.state = "running";
  expect(() => summarizePilot(g.record(), g.split)).toThrow("finished");
  const h = setup();
  const row = h.target.rb.methods[0]?.entries[0];
  assert(row);
  row.value = 101;
  expect(() => summarizePilot(h.record(), h.split)).toThrow("within 0..100");
});
it("bounds sizing inputs and matches the design's first-round scale", () => {
  expect(requiredTasks(0.1, 5)).toBeGreaterThan(290);
  expect(requiredTasks(0.1, 5)).toBeLessThan(305);
  expect(requiredTasks(0.1, 10)).toBeGreaterThan(70);
  expect(flipUpper(0, 0)).toBeNull();
  expect(flipUpper(8, 8)).toBe(1);
  for (const args of [
    [NaN, 5],
    [0.1, 0],
    [1.1, 5],
    [0.1, 5, 0.05, 1],
  ]) {
    expect(() => requiredTasks(args[0] ?? 0, args[1] ?? 5, args[2], args[3])).toThrow();
  }
  expect(() => flipUpper(9, 8)).toThrow();
});

it("keeps all-invalid samples inconclusive and rejects a different frozen source", () => {
  const f = setup();
  for (const report of f.evidence.reports)
    for (const entry of report.methods[0]?.entries ?? []) {
      entry.evaluation = "invalid";
      entry.value = null;
    }
  const summary = summarizePilot(f.record(), f.split);
  expect(summary.observations.invalidRate).toBe(1);
  expect(summary.observations.flipRate).toBeNull();
  expect(summary.sizing).toBeNull();
  const g = setup();
  g.split.manifest.benchmark.identity.version = "changed";
  expect(() => summarizePilot(g.record(), g.split)).toThrow("source version");
});

it("uses a dataset metric override and preserves its reported meaning", () => {
  const f = setup();
  f.policy.gate.metric = "resolved";
  for (const job of f.evidence.jobs)
    job.metrics = [
      { name: "resolved", label: "Resolved", range: [0, 100], higherIsBetter: true, primary: true },
    ];
  for (const report of f.evidence.reports) report.metric = "resolved";
  expect(summarizePilot(f.record(), f.split).metric).toBe("resolved");
});

it("supplements only missing costs from explicit finalized Run snapshots without changing reports", () => {
  const f = setup();
  const row = f.target.rb.methods[0]?.costs?.[0];
  assert(row);
  row.tokens = null;
  row.wallSeconds = null;
  const run = Run.parse({
    id: row.run,
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
    createdAt: "2026-11-17T00:00:00Z",
    startedAt: "2026-11-17T00:00:00Z",
    endedAt: "2026-11-17T00:00:05Z",
    tokens: {
      input: 100,
      output: 20,
      cachedInput: 80,
      cacheWrite: null,
      reasoning: null,
      calls: 1,
      source: "session",
    },
  });
  const record = f.record();
  const before = JSON.stringify(record);
  const result = summarizePilot(record, f.split, {}, [run]);
  expect(result.costs.supplementedRuns).toBe(1);
  expect(result.costs.tokens.meanPerTrial).toBe(120);
  expect(result.costs.wall.meanSecondsPerTrial).toBe(155 / 16);
  expect(JSON.stringify(record)).toBe(before);
  run.cleanup = "pending";
  expect(() => summarizePilot(record, f.split, {}, [run])).toThrow("finalized");
});
