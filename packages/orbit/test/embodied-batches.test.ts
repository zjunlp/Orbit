// Real planning/store/state machine, with explicitly synthetic Runs and verifier replies.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { assignSolveBatches, batchConditions } from "../src/bench/batches.ts";
import { planConsolidation } from "../src/bench/consolidate.ts";
import { AdapterClient } from "../src/bench/protocol.ts";
import { BenchmarkRegistry } from "../src/bench/registry.ts";
import { contentDigest } from "../src/bench/samples.ts";
import { BenchService } from "../src/bench/service.ts";
import { planDigest } from "../src/bench/summary.ts";
import { ensureHome, orbitPaths } from "../src/config/paths.ts";
import { BenchJob, PolicyDefinition, Run, Trial, trialRunIds } from "../src/contracts/index.ts";
import { RunService } from "../src/runs/service.ts";
import { Store } from "../src/store/index.ts";

const fixtures: { store: Store; home: string }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    fixture.store.close();
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "orbit-batch-test-"));
  const paths = orbitPaths({ ORBIT_HOME: home });
  ensureHome(paths);
  const store = new Store(paths.db);
  fixtures.push({ store, home });
  const registry = new BenchmarkRegistry(paths.benchmarks);
  registry.put({ name: "synthetic", adapter: "harbor", path: home });
  const runs = new RunService({ store, paths, probe: vi.fn() });
  const bench = new BenchService({ store, paths, runs, registry, self: [process.execPath] });
  const at = new Date().toISOString();
  const items = [0, 1, 2].map((initialStateId) => {
    const content = {
      taskId: "task",
      benchmarkProfile: "synthetic",
      initialStateId: String(initialStateId),
      initialStateDigest: `sha256:${"a".repeat(64)}`,
      environmentSeed: 0,
      policySeed: 0,
      repetition: 0,
    };
    return { ...content, sampleId: contentDigest(content) };
  });
  const job = BenchJob.parse({
    id: "job",
    spec: {
      benchmark: "synthetic",
      tasks: ["task"],
      methods: [{ name: "p", agent: "policy", policyRef: "p" }],
      samplePlan: { version: 1, items, digest: contentDigest(items) },
      batchSize: 3,
    },
    state: "running",
    createdAt: at,
    endedAt: null,
    resolvedBindings: {
      p: {
        version: 1,
        benchmarkProfile: {
          id: "b",
          observations: {},
          action: {
            semantic: "control",
            shape: [1],
            controller: "native",
            frame: "world",
            unit: "normalized",
            rotation: "none",
            gripper: "native",
          },
        },
        policyProfile: {
          id: "p",
          observations: {},
          action: {
            semantic: "control",
            shape: [1],
            controller: "native",
            frame: "world",
            unit: "normalized",
            rotation: "none",
            gripper: "native",
          },
        },
        observationMap: {},
        digest: `sha256:${"a".repeat(64)}`,
      },
    },
  });
  const trials = items.map((sample, index) =>
    Trial.parse({
      id: `job.${index}`,
      jobId: job.id,
      task: "task",
      sampleRef: sample.sampleId,
      method: "p",
      state: "pending",
      solveRunId: null,
      verifyRunId: null,
      outcome: null,
      createdAt: at,
      endedAt: null,
    }),
  );
  assignSolveBatches(job, trials);
  store.putJob(job);
  for (const trial of trials) store.putTrial(trial);
  const plan = trials[0]?.batch?.plan;
  if (!plan) throw new Error("missing batch fixture");
  const solve = Run.parse({
    id: "shared",
    spec: {
      image: "synthetic",
      command: ["true"],
      group: "bench-job",
      tags: {
        bench: "synthetic",
        execution_batch: plan.id,
        batch_attempt: plan.attemptId,
        phase: "solve",
        batch_size: "3",
      },
      params: { batchDigest: plan.digest },
    },
    state: "queued",
    reason: null,
    exitCode: null,
    node: "test",
    image: null,
    containerId: null,
    lease: null,
    code: null,
    cleanup: "pending",
    note: "",
    createdAt: at,
    startedAt: null,
    endedAt: null,
  });
  let sequence = 0;
  const submit = vi.spyOn(runs, "submit").mockImplementation(async (spec) => {
    const run = Run.parse({ ...solve, id: `verify-${++sequence}`, spec });
    store.putRun(run);
    mkdirSync(runs.dirs(run.id).output, { recursive: true });
    return run;
  });
  const verify = vi.spyOn(AdapterClient.prototype, "verify").mockImplementation(async (trial) => {
    const member = trial.batch?.plan.members[trial.batch.index];
    if (
      !member ||
      !existsSync(
        join(runs.dirs(solve.id).output, "episodes", member.episodeId, "evidence-manifest.json"),
      )
    )
      throw new Error("synthetic missing episode evidence");
    return { spec: { image: "synthetic", command: ["true"] }, issues: [] };
  });
  vi.spyOn(AdapterClient.prototype, "score").mockResolvedValue({
    score: 1,
    maxScore: 1,
    invalid: false,
    issues: [],
  });
  const finishVerify = (id: string | null) => {
    const run = id ? store.getRun(id) : null;
    if (!run) throw new Error("missing verifier");
    const finished = {
      ...run,
      state: "succeeded" as const,
      startedAt: at,
      endedAt: at,
      cleanup: "done" as const,
    };
    store.putRun(finished);
    runs.emit("change", { run: finished });
  };
  return { store, runs, bench, job, trials, solve, plan, at, submit, verify, finishVerify };
}

it.each(["cancelled", "failed"] as const)(
  "keeps completed episode valid after shared solve %s",
  async (state) => {
    const f = fixture();
    const first = f.trials[0];
    const member = first?.batch?.plan.members[0];
    if (!first || !member) throw new Error("missing episode fixture");
    const directory = join(f.runs.dirs(f.solve.id).output, "episodes", member.episodeId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "evidence-manifest.json"), "explicit synthetic verifier input");
    f.store.putJob({ ...f.job, state: state === "cancelled" ? "cancelled" : "running" });
    const solve = {
      ...f.solve,
      state,
      startedAt: f.at,
      endedAt: f.at,
      cleanup: "done" as const,
      services:
        state === "failed"
          ? [
              {
                name: "policy",
                containerId: "synthetic",
                state: "failed",
                failure: "later service failure",
              },
            ]
          : [],
    };
    f.store.putRun(Run.parse(solve));
    for (const trial of f.trials)
      f.store.putTrial({ ...trial, solveRunId: solve.id, state: "solving" });
    f.bench.start();
    await expect.poll(() => f.store.getTrial(first.id)?.state).toBe("verifying");
    f.finishVerify(f.store.getTrial(first.id)?.verifyRunId ?? null);
    await expect
      .poll(() => f.store.trials(f.job.id).every((trial) => trial.state === "done"))
      .toBe(true);
    expect(f.store.getTrial(first.id)?.outcome).toMatchObject({
      execution: state,
      evaluation: "valid",
      score: 1,
    });
    expect(
      f.store
        .trials(f.job.id)
        .slice(1)
        .every(
          (trial) => trial.outcome?.evaluation === (state === "cancelled" ? "unknown" : "invalid"),
        ),
    ).toBe(true);
    const before = f.store.trials(f.job.id);
    f.bench.rescore(f.job.id, { trials: [first.id] });
    await expect.poll(() => f.store.getTrial(first.id)?.state).toBe("verifying");
    f.finishVerify(f.store.getTrial(first.id)?.verifyRunId ?? null);
    await expect.poll(() => f.store.getTrial(first.id)?.state).toBe("done");
    expect(f.store.trials(f.job.id).slice(1)).toEqual(before.slice(1));
    expect(f.store.getTrial(first.id)?.history).toHaveLength(1);
  },
);

it("adopts a persisted batch Run after a crash before trial links were written", async () => {
  const f = fixture();
  f.store.putRun(f.solve);
  const adapter = vi.spyOn(AdapterClient.prototype, "solve");
  f.bench.start();
  await expect
    .poll(() => f.store.trials(f.job.id).every((trial) => trial.solveRunId === f.solve.id))
    .toBe(true);
  expect(f.store.trialsByRun(f.solve.id, "solve")).toHaveLength(3);
  expect(f.submit).not.toHaveBeenCalled();
  expect(adapter).not.toHaveBeenCalled();
});

it("stops an unlinked batch Run of a job cancelled before a restart", async () => {
  const f = fixture();
  const tags = { ...f.solve.spec.tags, job: f.job.id };
  const solve = Run.parse({ ...f.solve, spec: { ...f.solve.spec, tags } });
  f.store.putRun(solve);
  f.store.putJob({ ...f.job, state: "cancelled", endedAt: f.at });
  const cancel = vi.spyOn(f.runs, "cancel").mockImplementation(async (id) => {
    const stopping = { ...(f.store.getRun(id) as Run), stopRequested: "cancel" as const };
    f.store.putRun(stopping);
    return stopping;
  });
  // Restart order: stop intent is restored before RunService schedules queued work.
  await f.bench.enforceCalibrationBudgets();
  expect(cancel).toHaveBeenCalledWith(solve.id);
  f.bench.start();
  await expect
    .poll(() => f.store.trials(f.job.id).every((trial) => trial.state === "done"))
    .toBe(true);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(f.store.trialsByRun(solve.id, "solve")).toHaveLength(3);
  expect(f.store.trials(f.job.id).every((t) => t.outcome?.cleanup === "pending")).toBe(true);
  const stopped = { ...solve, state: "cancelled" as const, cleanup: "done" as const };
  f.store.putRun(stopped);
  f.runs.emit("change", { run: stopped });
  await expect
    .poll(() => f.store.trials(f.job.id).every((t) => t.outcome?.cleanup === "done"))
    .toBe(true);
  expect(f.submit).not.toHaveBeenCalled();
});

it("keeps shared cleanup pending when cancellation races with Run submission", async () => {
  const f = fixture();
  const method = f.job.spec.methods[0];
  const profile = f.job.resolvedBindings?.p?.policyProfile;
  if (!method || !profile) throw new Error("missing policy fixture");
  method.policySnapshot = PolicyDefinition.parse({
    name: "p",
    version: "synthetic",
    connector: "openpi-ws",
    profile,
    checkpointDigest: `sha256:${"a".repeat(64)}`,
    normalizationDigest: `sha256:${"b".repeat(64)}`,
    service: {
      name: "policy",
      image: `sha256:${"c".repeat(64)}`,
      command: ["true"],
      gpus: 0,
      healthcheck: { command: ["true"] },
    },
  });
  f.store.putJob(f.job);
  vi.spyOn(AdapterClient.prototype, "solve").mockResolvedValue({
    spec: { image: "synthetic", command: ["true"] },
    issues: [],
  });
  f.submit.mockImplementation(async (spec) => {
    const run = Run.parse({ ...f.solve, spec });
    f.store.putRun(run);
    await f.bench.cancel(f.job.id);
    // Let pending peers finish before the in-flight submission publishes their shared Run link.
    await setImmediate();
    return run;
  });
  const cancel = vi.spyOn(f.runs, "cancel").mockImplementation(async (id) => {
    const run = f.store.getRun(id);
    if (!run) throw new Error("missing submitted Run");
    const stopping = { ...run, stopRequested: "cancel" as const };
    f.store.putRun(stopping);
    return stopping;
  });
  f.bench.start();
  await expect.poll(() => cancel.mock.calls.length).toBe(1);
  // The in-flight submission links the shared Run, so peers wait for its cleanup.
  await expect
    .poll(() =>
      f.store
        .trials(f.job.id)
        .slice(1)
        .every((trial) => trial.state === "done" && trial.outcome?.cleanup === "pending"),
    )
    .toBe(true);
  const stopped = { ...f.solve, state: "cancelled" as const, cleanup: "done" as const };
  f.store.putRun(stopped);
  f.runs.emit("change", { run: stopped });
  await expect
    .poll(() =>
      f.store
        .trials(f.job.id)
        .every((trial) => trial.state === "done" && trial.outcome?.cleanup === "done"),
    )
    .toBe(true);
});

it("freezes sequential membership and separates batch conditions from single-episode plans", () => {
  const f = fixture();
  expect(f.plan.members.map((member) => member.trialId)).toEqual(f.trials.map((trial) => trial.id));
  expect(planDigest(f.job)).not.toBe(
    planDigest({ ...f.job, spec: { ...f.job.spec, batchSize: undefined } }),
  );
  expect(batchConditions(f.trials[1] as Trial)).toMatchObject({ index: 1, randomness: "service" });
  const changed = structuredClone(f.job);
  changed.spec.batchSize = 2;
  const trials = structuredClone(f.trials);
  assignSolveBatches(changed, trials);
  expect(trials.map((trial) => trial.batch?.plan.members.length)).toEqual([2, 2, 1]);
  expect(batchConditions(trials[1] as Trial)).not.toEqual(batchConditions(f.trials[1] as Trial));
});

it("splits batches by the same effective budget that comparison conditions record", () => {
  const f = fixture();
  const items = (f.job.spec.samplePlan?.items ?? []).slice(0, 2).map((item, index) => {
    const { sampleId: _, ...content } = { ...item, taskId: index ? "b" : "a" };
    return { ...content, sampleId: contentDigest(content) };
  });
  const job = (resources?: BenchJob["resources"]) => {
    const j = structuredClone(f.job);
    j.spec = {
      ...j.spec,
      tasks: ["a", "b"],
      batchSize: 2,
      timeoutMin: 30,
      samplePlan: { version: 1, items, digest: contentDigest(items) },
    } as BenchJob["spec"];
    if (resources) j.resources = resources;
    return j;
  };
  const sizes = (j: BenchJob) => {
    const trials = items.map((item, index) =>
      Trial.parse({ ...f.trials[index], task: item.taskId, sampleRef: item.sampleId }),
    );
    assignSolveBatches(j, trials);
    return trials.map((trial) => trial.batch?.plan.members.length);
  };
  // Per-task timeouts are overridden by the job timeout: one shared service either way.
  const overridden = job({ a: { timeoutMin: 10 }, b: { timeoutMin: 20 } });
  const plain = job();
  expect(sizes(overridden)).toEqual([2, 2]);
  expect(sizes(plain)).toEqual([2, 2]);
  expect(planDigest(overridden)).toBe(planDigest(plain));
  // A real budget change splits the batch and changes the recorded conditions.
  const split = job({ a: { memGB: 4 } });
  expect(sizes(split)).toEqual([1, 1]);
  expect(planDigest(split)).not.toBe(planDigest(plain));
});

it("does not replace a valid completed episode merely because its shared Run later failed", () => {
  const f = fixture();
  const outcome = {
    execution: "failed",
    evaluation: "valid" as const,
    score: 1,
    maxScore: 1,
    issues: [],
    cleanup: "done" as const,
    review: null,
  };
  const target = f.trials.map((trial) => ({
    ...trial,
    state: "done" as const,
    solveRunId: "shared",
    outcome,
  }));
  const donor = f.trials.map((trial, index) => ({
    ...trial,
    id: `retry.${index}`,
    jobId: "retry",
    state: "done" as const,
    solveRunId: "retry-run",
    outcome,
  }));
  const job = { ...f.job, id: "retry" };
  assignSolveBatches(job, donor);
  expect(() =>
    planConsolidation({
      target: { job: f.job, trials: target, summary: [] },
      donors: [{ job, trials: donor, summary: [] }],
      oldRuns: new Map([
        ["shared", { ...f.solve, state: "failed" as const }],
        ["retry-run", { ...f.solve, id: "retry-run", state: "succeeded" as const }],
      ]),
      failures: new Map(),
      flags: { sources: ["retry"], replaceFailed: true },
    }),
  ).toThrow(/refusing to replace valid trial/);
});

it("retains previous shared solve evidence and ownership when batch retries are adopted", () => {
  const f = fixture();
  const invalid = {
    execution: "failed",
    evaluation: "invalid" as const,
    score: null,
    maxScore: 1,
    issues: [],
    cleanup: "done" as const,
    review: null,
  };
  const valid = { ...invalid, execution: "succeeded", evaluation: "valid" as const, score: 1 };
  const target = f.trials.map((trial) => ({
    ...trial,
    state: "done" as const,
    solveRunId: "shared",
    outcome: invalid,
  }));
  const donor = f.trials.map((trial, index) => ({
    ...trial,
    id: `retry.${index}`,
    jobId: "retry",
    state: "done" as const,
    solveRunId: "retry-run",
    outcome: valid,
  }));
  const job = { ...f.job, id: "retry" };
  assignSolveBatches(job, donor);
  const planned = planConsolidation({
    target: { job: f.job, trials: target, summary: [] },
    donors: [{ job, trials: donor, summary: [] }],
    oldRuns: new Map([
      ["shared", { ...f.solve, state: "failed" as const }],
      ["retry-run", { ...f.solve, id: "retry-run", state: "succeeded" as const }],
    ]),
    failures: new Map(),
    flags: { sources: ["retry"], replaceFailed: true },
  });
  expect(planned.removedRuns).toEqual([]);
  expect(planned.trials.every((trial) => trial.priorAttempts?.[0]?.solveRunId === "shared")).toBe(
    true,
  );
  for (const trial of planned.trials) {
    f.store.putTrial(trial);
    expect(trialRunIds(trial)).toContain("shared");
  }
  expect(f.store.trialsByRun("shared", "solve")).toHaveLength(3);
  expect(f.store.trialsByRun("retry-run", "solve")).toHaveLength(3);
});
