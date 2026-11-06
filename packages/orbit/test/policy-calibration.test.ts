// Real contracts, store and lifecycle with explicit synthetic model/adapter/Run replies; no inference.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { planConsolidation } from "../src/bench/consolidate.ts";
import { AdapterClient } from "../src/bench/protocol.ts";
import { BenchmarkRegistry } from "../src/bench/registry.ts";
import { contentDigest } from "../src/bench/samples.ts";
import { BenchService } from "../src/bench/service.ts";
import { calibrate } from "../src/cli/calibrate.ts";
import type { OrbitClient } from "../src/client/index.ts";
import { ensureHome, orbitPaths } from "../src/config/paths.ts";
import {
  AdapterTasksResponse,
  BenchJobSpec,
  CalibrationReport,
  CalibrationRequest,
  formatCalibration,
  Run,
} from "../src/contracts/index.ts";
import { RunService } from "../src/runs/service.ts";
import * as sessions from "../src/sessions/index.ts";
import { Store } from "../src/store/index.ts";

const fixtures: { home: string; store: Store; bench: BenchService }[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.bench.stop();
    f.store.close();
    rmSync(f.home, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function plan(count = 2) {
  const items = Array.from({ length: count }, (_, i) => {
    const content = {
      taskId: "task",
      benchmarkProfile: "synthetic",
      initialStateId: String(i),
      initialStateDigest: `sha256:${"a".repeat(64)}`,
      environmentSeed: 7,
      policySeed: 0 as const,
      repetition: 0,
    };
    return { ...content, sampleId: contentDigest(content) };
  });
  return { version: 1 as const, items, digest: contentDigest(items) };
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "orbit-policy-calibrate-"));
  const paths = orbitPaths({ ORBIT_HOME: home });
  ensureHome(paths);
  const store = new Store(paths.db);
  const registry = new BenchmarkRegistry(paths.benchmarks);
  registry.put({ name: "synthetic", path: home, adapter: "harbor" });
  const runs = new RunService({ store, paths, probe: vi.fn() });
  const deps = { store, paths, runs, registry, self: [process.execPath] };
  const bench = new BenchService(deps);
  fixtures.push({ home, store, bench });
  const profile = {
    id: "synthetic",
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
  };
  bench.policies.put({
    name: "synthetic",
    version: "fixture",
    kind: "model",
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
  vi.spyOn(AdapterClient.prototype, "tasks").mockResolvedValue(
    AdapterTasksResponse.parse({
      tasks: [{ id: "task", title: null, supported: true, reason: null, tags: {} }],
      capabilities: {
        kind: "other",
        category: "embodied-policy",
        methods: ["policy"],
        conditions: {},
        scoreKind: "binary",
        rescore: "evidence",
        profiles: ["sim", "sync", "step"],
        domains: ["embodied"],
        calibration: { oracle: "none", seedsVary: true },
        embodied: {
          profile: "synthetic",
          semanticProfile: profile,
          observationMap: {},
          batch: { maxEpisodes: 128 },
        },
      },
    }),
  );
  const solve = vi
    .spyOn(AdapterClient.prototype, "solve")
    .mockResolvedValue({ spec: { image: "synthetic", command: ["true"] }, issues: [] });
  vi.spyOn(AdapterClient.prototype, "verify").mockResolvedValue({
    spec: { image: "synthetic", command: ["true"], resources: { gpus: 0 } },
    issues: [],
  });
  vi.spyOn(AdapterClient.prototype, "score").mockResolvedValue({
    score: 0,
    maxScore: 1,
    invalid: false,
    issues: [],
  });
  let sequence = 0;
  const submit = vi.spyOn(runs, "submit").mockImplementation(async (spec) => {
    const run = Run.parse({
      id: `run-${++sequence}`,
      spec,
      state: "queued",
      reason: null,
      exitCode: null,
      node: "synthetic",
      image: null,
      containerId: null,
      lease: null,
      code: null,
      cleanup: "pending",
      note: "",
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
    });
    store.putRun(run);
    mkdirSync(runs.dirs(run.id).output, { recursive: true });
    return run;
  });
  const finish = (id: string | null, state: "succeeded" | "cancelled" = "succeeded") => {
    const run = id ? store.getRun(id) : null;
    if (!run) throw new Error("missing synthetic Run");
    const done = {
      ...run,
      state,
      cleanup: "done" as const,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    };
    store.putRun(done);
    runs.emit("change", { run: done });
    return done;
  };
  const cancel = vi.spyOn(runs, "cancel").mockImplementation(async (id) => finish(id, "cancelled"));
  const request = {
    benchmark: "synthetic",
    policyRef: "synthetic",
    samplePlan: plan(),
    budgetMin: 20,
  };
  async function firstScores(id: string) {
    await expect.poll(() => store.trials(id).every((t) => t.state === "solving")).toBe(true);
    finish(store.trials(id)[0]?.solveRunId ?? null);
    await expect.poll(() => store.trials(id).every((t) => t.state === "verifying")).toBe(true);
    for (const t of store.trials(id)) finish(t.verifyRunId);
    await expect.poll(() => store.trials(id)[0]?.history.length).toBe(1);
    await expect.poll(() => store.trials(id)[0]?.state).toBe("verifying");
  }
  return {
    home,
    paths,
    store,
    runs,
    registry,
    deps,
    bench,
    solve,
    submit,
    cancel,
    finish,
    request,
    firstScores,
  };
}

it("bounds policy requests and rejects mixing legacy calibration fields or oversized direct jobs", () => {
  const input = { benchmark: "synthetic", policyRef: "synthetic", samplePlan: plan() };
  expect(CalibrationRequest.parse(input)).toMatchObject({ budgetMin: 20, rescore: true });
  for (const extra of [
    { samplePlan: plan(1) },
    { samplePlan: plan(6) },
    { budgetMin: 31 },
    { seeds: 2 },
    { oracle: true },
  ])
    expect(CalibrationRequest.safeParse({ ...input, ...extra }).success).toBe(false);
  expect(CalibrationRequest.safeParse({ benchmark: "b", sample: 3, seeds: 2 }).success).toBe(true);
  expect(
    BenchJobSpec.safeParse({
      benchmark: "b",
      samplePlan: plan(6),
      batchSize: 6,
      calibration: { mode: "policy", budgetMin: 20 },
      methods: [{ name: "p", agent: "policy", policyRef: "p" }],
    }).success,
  ).toBe(false);
});

it("accepts valid zero native scores, shares a solve, rescores one episode and separates catalog fidelity", async () => {
  const f = fixture();
  const job = await f.bench.calibrate(f.request);
  await f.firstScores(job.id);
  const other = structuredClone(f.store.trials(job.id)[1]);
  f.finish(f.store.trials(job.id)[0]?.verifyRunId ?? null);
  await expect.poll(() => f.bench.job(job.id).calibration?.phase).toBe("done");
  const detail = f.bench.job(job.id);
  const report = detail.calibration;
  expect(report).toMatchObject({
    mode: "policy",
    policyRef: "synthetic",
    samples: 2,
    calibrated: true,
    budget: { minutes: 20 },
  });
  expect(report?.checks.every((c) => c.result === "passed")).toBe(true);
  expect(f.solve).toHaveBeenCalledTimes(1);
  expect(f.submit).toHaveBeenCalledTimes(4);
  expect(detail.trials[1]).toEqual(other);
  expect(detail.trials[0]?.outcome?.score).toBe(0);
  const entry = f.bench.catalog().entries[0];
  expect(entry).toMatchObject({
    calibrations: [],
    fidelity: "experimental",
    policyChecks: [{ job: job.id, calibrated: true }],
  });
  expect(formatCalibration(report as NonNullable<typeof report>)).toContain(
    "policy integration passed",
  );
  const client = {
    benchCalibrate: vi.fn().mockResolvedValue(job),
    benchJob: vi.fn().mockResolvedValue(detail),
  };
  const { benchmark, ...options } = f.request;
  expect(
    await calibrate(client as unknown as OrbitClient, benchmark, { ...options, waitMin: 1 }),
  ).toEqual(report);
  expect(client.benchCalibrate).toHaveBeenCalledWith(
    expect.objectContaining({ policyRef: "synthetic", budgetMin: 20, samplePlan: plan() }),
  );
  expect(() =>
    planConsolidation({
      target: detail,
      donors: [],
      oldRuns: new Map(),
      failures: new Map(),
      flags: { sources: [] },
    }),
  ).toThrow(/bounded execution/);
});

it("does not accept a calibration fixture as evidence of a real model integration", async () => {
  const f = fixture();
  const policy = f.bench.policies.get("synthetic");
  if (!policy) throw new Error("missing fixture");
  f.bench.policies.put({ ...policy, kind: "calibration" });
  await expect(f.bench.calibrate(f.request)).rejects.toThrow(/real model/);
  expect(f.submit).not.toHaveBeenCalled();
});

it.each(["queued", "starting"] as const)(
  "enforces the total budget while %s and never reports a cancelled check as calibrated",
  async (state) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const f = fixture();
    const job = await f.bench.calibrate(f.request);
    await setImmediate();
    expect(f.submit).toHaveBeenCalledTimes(1);
    const queued = f.store.getRun(f.store.trials(job.id)[0]?.solveRunId ?? "");
    if (!queued) throw new Error("missing synthetic queued Run");
    f.store.putRun({ ...queued, state });
    await vi.advanceTimersByTimeAsync(20 * 60_000 + 1);
    await setImmediate();
    const detail = f.bench.job(job.id);
    expect(detail.job).toMatchObject({
      state: "cancelled",
      calibrationExpiredAt: expect.any(String),
      rescore: { state: "done" },
    });
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(detail.calibration).toMatchObject({ phase: "done", calibrated: false });
    expect(detail.calibration?.checks.find((c) => c.name === "acceptance budget")?.result).toBe(
      "failed",
    );
  },
);

it("stops all initial CPU verifiers and skips automatic rescore after budget exhaustion", async () => {
  const f = fixture();
  const job = await f.bench.calibrate(f.request);
  await setImmediate();
  f.finish(f.store.trials(job.id)[0]?.solveRunId ?? null);
  await expect.poll(() => f.store.trials(job.id).every((t) => t.state === "verifying")).toBe(true);
  const current = f.store.getJob(job.id);
  if (!current) throw new Error("missing job");
  f.store.putJob({ ...current, createdAt: new Date(Date.now() - 21 * 60_000).toISOString() });
  await f.bench.enforceCalibrationBudgets();
  await setImmediate();
  expect(f.cancel).toHaveBeenCalledTimes(2);
  expect(f.submit).toHaveBeenCalledTimes(3);
  await expect.poll(() => f.bench.job(job.id).calibration?.phase).toBe("done");
  expect(f.bench.job(job.id).calibration).toMatchObject({ phase: "done", calibrated: false });
});

it("allows explicit later CPU rescore without erasing a failed acceptance budget", async () => {
  const f = fixture();
  const job = await f.bench.calibrate(f.request);
  await f.firstScores(job.id);
  const current = f.store.getJob(job.id);
  if (!current) throw new Error("missing job");
  f.store.putJob({ ...current, createdAt: new Date(Date.now() - 21 * 60_000).toISOString() });
  await f.bench.enforceCalibrationBudgets();
  await expect.poll(() => f.bench.job(job.id).calibration?.phase).toBe("done");
  const selected = f.store.trials(job.id)[0];
  if (!selected) throw new Error("missing trial");
  f.bench.rescore(job.id, { trials: [selected.id] });
  await expect.poll(() => f.store.getTrial(selected.id)?.state).toBe("verifying");
  f.finish(f.store.getTrial(selected.id)?.verifyRunId ?? null);
  await expect.poll(() => f.store.getTrial(selected.id)?.state).toBe("done");
  expect(f.store.getTrial(selected.id)?.outcome?.evaluation).toBe("valid");
  expect(f.solve).toHaveBeenCalledTimes(1);
  expect(f.bench.job(job.id).calibration?.calibrated).toBe(false);
  expect(f.store.getJob(job.id)?.calibrationExpiredAt).toBeTruthy();
});

it("cancels a Run linked after expiry and keeps cleanup pending until its stop is confirmed", async () => {
  const f = fixture();
  const submit = f.submit.getMockImplementation();
  if (!submit) throw new Error("missing synthetic submission");
  let release: (() => void) | undefined;
  f.submit.mockImplementation(async (...args) => {
    const run = await submit(...args);
    f.store.putRun({ ...run, state: "starting" });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return run;
  });
  f.cancel.mockImplementation(async (id) => {
    const run = f.store.getRun(id);
    if (!run) throw new Error("missing synthetic starting Run");
    const stopping = { ...run, stopRequested: "cancel" as const };
    f.store.putRun(stopping);
    f.runs.emit("change", { run: stopping });
    return stopping;
  });
  const job = await f.bench.calibrate(f.request);
  await setImmediate();
  const current = f.store.getJob(job.id);
  if (!current) throw new Error("missing job");
  f.store.putJob({ ...current, createdAt: new Date(Date.now() - 21 * 60_000).toISOString() });
  await f.bench.enforceCalibrationBudgets();
  await setImmediate();
  release?.();
  await setImmediate();
  await setImmediate();
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.cancel).toHaveBeenCalledTimes(1);
  expect(
    f.store.trials(job.id).every((t) => t.state !== "done" || t.outcome?.cleanup === "pending"),
  ).toBe(true);
  expect(f.bench.job(job.id).calibration?.phase).not.toBe("done");
  f.finish(f.store.trials(job.id)[0]?.solveRunId ?? null, "cancelled");
  await expect
    .poll(() => f.store.trials(job.id).every((t) => t.outcome?.cleanup === "done"))
    .toBe(true);
  expect(
    f.store.trials(job.id).every((t) => t.state === "done" && t.outcome?.cleanup === "done"),
  ).toBe(true);
  expect(f.store.listRuns({ limit: 100 }).every((r) => r.state === "cancelled")).toBe(true);
});

it("honors an expired budget before restart can schedule another Run", async () => {
  const f = fixture();
  const job = await f.bench.calibrate(f.request);
  await setImmediate();
  f.bench.stop();
  f.store.putJob({
    ...(f.store.getJob(job.id) as typeof job),
    createdAt: new Date(Date.now() - 21 * 60_000).toISOString(),
  });
  const recovered = new BenchService(f.deps);
  const active = fixtures[0];
  if (!active) throw new Error("missing active fixture");
  active.bench = recovered;
  await recovered.enforceCalibrationBudgets();
  recovered.start();
  await setImmediate();
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.cancel).toHaveBeenCalledTimes(1);
  expect(recovered.job(job.id).calibration).toMatchObject({ phase: "done", calibrated: false });
});

it("cancels an unlinked durable solve on restart and waits for its cleanup without touching another job", async () => {
  const f = fixture();
  const submit = f.submit.getMockImplementation();
  if (!submit) throw new Error("missing synthetic submission");
  f.submit.mockImplementation(async (...args) => {
    await submit(...args);
    return new Promise<Run>(() => {});
  });
  const job = await f.bench.calibrate(f.request);
  await setImmediate();
  const run = f.store.listRuns({ limit: 10 })[0];
  if (!run) throw new Error("missing durable synthetic Run");
  expect(f.store.trials(job.id).every((t) => t.state === "pending" && !t.solveRunId)).toBe(true);
  const other = await submit({ ...run.spec, tags: { ...run.spec.tags, job: "another-job" } });
  f.cancel.mockImplementation(async (id) => {
    const stopping = { ...(f.store.getRun(id) as Run), state: "cancelled" as const };
    f.store.putRun(stopping);
    f.runs.emit("change", { run: stopping });
    return stopping;
  });
  f.bench.stop();
  f.store.putJob({ ...job, createdAt: new Date(Date.now() - 21 * 60_000).toISOString() });
  const recovered = new BenchService(f.deps);
  const active = fixtures[0];
  if (!active) throw new Error("missing fixture");
  active.bench = recovered;
  await recovered.enforceCalibrationBudgets();
  recovered.start();
  await expect.poll(() => f.store.trials(job.id).every((t) => t.state === "done")).toBe(true);
  expect(f.cancel).toHaveBeenCalledExactlyOnceWith(run.id);
  expect(f.store.getRun(run.id)?.state).toBe("cancelled");
  expect(f.store.getRun(other.id)?.state).toBe("queued");
  expect(recovered.job(job.id).calibration).toMatchObject({
    phase: "rescoring",
    calibrated: false,
  });
  expect(f.store.getJob(job.id)?.calibrationExecutionEndedAt).toBeUndefined();
  f.finish(run.id, "cancelled");
  await expect.poll(() => recovered.job(job.id).calibration?.phase).toBe("done");
  expect(recovered.job(job.id).calibration?.calibrated).toBe(false);
  expect(f.submit).toHaveBeenCalledTimes(1);
});

it("cancels a durable CPU verifier whose Trial linkage was interrupted", async () => {
  const f = fixture();
  const job = await f.bench.calibrate({ ...f.request, rescore: false });
  await expect.poll(() => f.store.trials(job.id).every((t) => t.state === "solving")).toBe(true);
  f.finish(f.store.trials(job.id)[0]?.solveRunId ?? null);
  await expect.poll(() => f.store.trials(job.id).every((t) => t.state === "verifying")).toBe(true);
  const trial = f.store.trials(job.id)[0];
  if (!trial?.verifyRunId) throw new Error("missing synthetic verifier");
  const verifier = trial.verifyRunId;
  f.bench.stop();
  f.store.putTrial({ ...trial, state: "solving", verifyRunId: null });
  f.store.putJob({ ...job, createdAt: new Date(Date.now() - 21 * 60_000).toISOString() });
  const recovered = new BenchService(f.deps);
  const active = fixtures[0];
  if (!active) throw new Error("missing fixture");
  active.bench = recovered;
  await recovered.enforceCalibrationBudgets();
  recovered.start();
  await expect.poll(() => recovered.job(job.id).calibration?.phase).toBe("done");
  expect(f.store.getRun(verifier)?.state).toBe("cancelled");
  expect(f.cancel).toHaveBeenCalledTimes(2);
  expect(f.submit).toHaveBeenCalledTimes(3);
});

it.each(["pending", "failed"] as const)(
  "waits for a historical verifier with %s cleanup, then finishes on its cleanup event",
  async (cleanup) => {
    const f = fixture();
    const job = await f.bench.calibrate(f.request);
    await expect.poll(() => f.store.trials(job.id).every((t) => t.state === "solving")).toBe(true);
    f.finish(f.store.trials(job.id)[0]?.solveRunId ?? null);
    await expect
      .poll(() => f.store.trials(job.id).every((t) => t.state === "verifying"))
      .toBe(true);
    const original = f.store.getRun(f.store.trials(job.id)[0]?.verifyRunId ?? "");
    if (!original) throw new Error("missing original verifier");
    const pending = {
      ...original,
      state: "succeeded" as const,
      cleanup,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    };
    f.store.putRun(pending);
    f.runs.emit("change", { run: pending });
    f.finish(f.store.trials(job.id)[1]?.verifyRunId ?? null);
    await expect.poll(() => f.store.trials(job.id)[0]?.history.length).toBe(1);
    await expect.poll(() => f.store.trials(job.id)[0]?.state).toBe("verifying");
    f.finish(f.store.trials(job.id)[0]?.verifyRunId ?? null);
    await expect.poll(() => f.store.trials(job.id).every((t) => t.state === "done")).toBe(true);
    const report = f.bench.job(job.id).calibration;
    expect(report).toMatchObject({ phase: "rescoring", calibrated: false });
    expect(report?.checks.find((c) => c.name === "cleanup confirmed")?.result).not.toBe("passed");
    await expect.poll(() => f.store.getJob(job.id)?.calibrationExecutionEndedAt).toBeTruthy();
    expect(f.store.getJob(job.id)?.rescore?.state).toBe("done");
    // The report must also distrust an old completion marker from before this fix.
    const current = f.store.getJob(job.id);
    if (!current) throw new Error("missing job");
    f.store.putJob({
      ...current,
      calibrationExecutionEndedAt: undefined,
      rescore: { state: "done" },
    });
    expect(f.bench.job(job.id).calibration).toMatchObject({
      phase: "rescoring",
      calibrated: false,
    });
    f.store.putJob(current);
    f.finish(original.id);
    await expect.poll(() => f.bench.job(job.id).calibration?.phase).toBe("done");
    expect(f.bench.job(job.id).calibration?.calibrated).toBe(true);
    expect(f.store.trials(job.id)[0]?.history[0]?.outcome.cleanup).toBe(cleanup);
    expect(f.submit).toHaveBeenCalledTimes(4);
  },
);

it.each([false, true])(
  "keeps the budget during automatic rescore planning (legacy marker: %s)",
  async (legacy) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(sessions, "loadRunAgentTranscript").mockResolvedValue(null);
    vi.spyOn(sessions, "runAgentFailure").mockResolvedValue(null);
    const f = fixture();
    let calls = 0;
    let release: ((r: Awaited<ReturnType<AdapterClient["verify"]>>) => void) | undefined;
    vi.mocked(AdapterClient.prototype.verify).mockImplementation(async () => {
      if (++calls === 3)
        return new Promise((resolve) => {
          release = resolve;
        });
      return {
        spec: { image: "synthetic", command: ["true"], resources: { gpus: 0 } },
        issues: [],
      };
    });
    const job = await f.bench.calibrate(f.request);
    await expect.poll(() => f.store.trials(job.id).every((t) => t.state === "solving")).toBe(true);
    f.finish(f.store.trials(job.id)[0]?.solveRunId ?? null);
    await expect
      .poll(() => f.store.trials(job.id).every((t) => t.state === "verifying"))
      .toBe(true);
    for (const t of f.store.trials(job.id)) f.finish(t.verifyRunId);
    await expect.poll(() => calls).toBe(3);
    await setImmediate();
    expect(f.store.getJob(job.id)?.rescore?.state).toBe("started");
    expect(f.store.getJob(job.id)?.calibrationExecutionEndedAt).toBeUndefined();
    if (legacy) {
      const current = f.store.getJob(job.id);
      if (!current) throw new Error("missing job");
      f.store.putJob({ ...current, rescore: { state: "done" } });
    }
    vi.setSystemTime(Date.now() + 21 * 60_000);
    await f.bench.enforceCalibrationBudgets();
    release?.({
      spec: { image: "synthetic", command: ["true"], resources: { gpus: 0 } },
      issues: [],
    });
    await expect.poll(() => f.bench.job(job.id).calibration?.phase).toBe("done");
    expect(f.store.getJob(job.id)?.state).toBe("cancelled");
    expect(f.bench.job(job.id).calibration?.calibrated).toBe(false);
    expect(f.store.getJob(job.id)?.calibrationExpiredAt).toBeTruthy();
    expect(f.submit).toHaveBeenCalledTimes(3);
  },
);

it.each([false, true])(
  "keeps on-time acceptance while historical cleanup crosses the deadline (restart: %s)",
  async (restart) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture();
    const job = await f.bench.calibrate(f.request);
    await expect.poll(() => f.store.trials(job.id).every((t) => t.state === "solving")).toBe(true);
    f.finish(f.store.trials(job.id)[0]?.solveRunId ?? null);
    await expect
      .poll(() => f.store.trials(job.id).every((t) => t.state === "verifying"))
      .toBe(true);
    const original = f.store.getRun(f.store.trials(job.id)[0]?.verifyRunId ?? "");
    if (!original) throw new Error("missing original verifier");
    const pending = {
      ...original,
      state: "succeeded" as const,
      cleanup: "pending" as const,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    };
    f.store.putRun(pending);
    f.runs.emit("change", { run: pending });
    f.finish(f.store.trials(job.id)[1]?.verifyRunId ?? null);
    await expect.poll(() => f.store.trials(job.id)[0]?.history.length).toBe(1);
    await expect.poll(() => f.store.trials(job.id)[0]?.state).toBe("verifying");
    f.finish(f.store.trials(job.id)[0]?.verifyRunId ?? null);
    await expect.poll(() => f.store.getJob(job.id)?.calibrationExecutionEndedAt).toBeTruthy();
    const executionEndedAt = f.store.getJob(job.id)?.calibrationExecutionEndedAt;
    expect(f.bench.job(job.id).calibration).toMatchObject({
      phase: "rescoring",
      calibrated: false,
      budget: { executionEndedAt },
    });
    expect(
      f.bench.job(job.id).calibration?.checks.find((c) => c.name === "acceptance budget")?.result,
    ).toBe("passed");
    let bench = f.bench;
    vi.setSystemTime(Date.now() + 21 * 60_000);
    if (restart) {
      bench.stop();
      bench = new BenchService(f.deps);
      const active = fixtures[0];
      if (!active) throw new Error("missing fixture");
      active.bench = bench;
    }
    await bench.enforceCalibrationBudgets();
    if (restart) bench.start();
    expect(f.store.getJob(job.id)?.calibrationExpiredAt).toBeUndefined();
    expect(f.store.getJob(job.id)?.state).toBe("done");
    expect(bench.job(job.id).calibration?.phase).toBe("rescoring");
    const cleaned = { ...pending, cleanup: "done" as const };
    f.store.putRun(cleaned);
    f.runs.emit("change", { run: cleaned });
    await expect.poll(() => bench.job(job.id).calibration?.phase).toBe("done");
    expect(bench.job(job.id).calibration?.calibrated).toBe(true);
    expect(f.store.getJob(job.id)?.calibrationExecutionEndedAt).toBe(executionEndedAt);
    expect(Date.parse(f.store.getJob(job.id)?.endedAt ?? "")).toBeGreaterThan(
      Date.parse(executionEndedAt ?? ""),
    );
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.submit).toHaveBeenCalledTimes(4);
  },
);

it("restores legacy completion from execution timestamps and keeps later manual CPU rescore outside that budget", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = fixture();
  const job = await f.bench.calibrate(f.request);
  await f.firstScores(job.id);
  f.finish(f.store.trials(job.id)[0]?.verifyRunId ?? null);
  await expect.poll(() => f.store.getJob(job.id)?.calibrationExecutionEndedAt).toBeTruthy();
  const current = f.store.getJob(job.id);
  if (!current) throw new Error("missing job");
  const expectedEnd = current.calibrationExecutionEndedAt;
  vi.setSystemTime(Date.now() + 21 * 60_000);
  f.store.putJob({
    ...current,
    calibrationExecutionEndedAt: undefined,
    endedAt: new Date().toISOString(),
  });
  await f.bench.enforceCalibrationBudgets();
  expect(f.store.getJob(job.id)?.calibrationExecutionEndedAt).toBe(expectedEnd);
  expect(f.store.getJob(job.id)?.calibrationExpiredAt).toBeUndefined();
  const selected = f.store.trials(job.id)[0];
  if (!selected) throw new Error("missing trial");
  f.bench.rescore(job.id, { trials: [selected.id] });
  await expect.poll(() => f.store.getTrial(selected.id)?.state).toBe("verifying");
  await f.bench.enforceCalibrationBudgets();
  f.finish(f.store.getTrial(selected.id)?.verifyRunId ?? null);
  await expect.poll(() => f.bench.job(job.id).calibration?.phase).toBe("done");
  expect(f.bench.job(job.id).calibration?.calibrated).toBe(true);
  expect(f.store.getJob(job.id)?.calibrationExecutionEndedAt).toBe(expectedEnd);
  expect(f.cancel).not.toHaveBeenCalled();
  expect(f.solve).toHaveBeenCalledTimes(1);
});

it("keeps CLI polling while execution is finished but cleanup remains", async () => {
  vi.useFakeTimers();
  const report = CalibrationReport.parse({
    benchmark: "synthetic",
    job: "job",
    tasks: ["task"],
    methods: ["policy"],
    seeds: 1,
    phase: "rescoring",
    checks: [],
    calibrated: false,
    mode: "policy",
    policyRef: "synthetic",
    samples: 2,
    budget: {
      minutes: 20,
      deadlineAt: "2026-11-06T00:20:00.000Z",
      executionEndedAt: "2026-11-06T00:01:00.000Z",
    },
    createdAt: "2026-11-06T00:00:00.000Z",
    endedAt: null,
    source: null,
  });
  const client = {
    benchCalibrate: vi.fn().mockResolvedValue({ id: "job" }),
    benchJob: vi
      .fn()
      .mockResolvedValueOnce({ calibration: report })
      .mockResolvedValueOnce({ calibration: { ...report, phase: "done", calibrated: true } }),
  };
  const progress = vi.fn();
  const waiting = calibrate(client as unknown as OrbitClient, "synthetic", {
    policyRef: "synthetic",
    samplePlan: plan(),
    waitMin: 1,
    progress,
  });
  await vi.advanceTimersByTimeAsync(3000);
  expect((await waiting).calibrated).toBe(true);
  expect(progress).toHaveBeenCalledWith("execution finished; waiting for resource cleanup");
  expect(client.benchJob).toHaveBeenCalledTimes(2);
});

it("stops the selected rescore when the budget expires after the job initially ended", async () => {
  const f = fixture();
  const job = await f.bench.calibrate(f.request);
  await f.firstScores(job.id);
  expect(f.store.getJob(job.id)?.state).toBe("done");
  const old = f.store.getJob(job.id);
  if (!old) throw new Error("missing job");
  f.store.putJob({ ...old, createdAt: new Date(Date.now() - 21 * 60_000).toISOString() });
  await f.bench.enforceCalibrationBudgets();
  await setImmediate();
  expect(f.cancel).toHaveBeenCalledTimes(1);
  await expect.poll(() => f.bench.job(job.id).calibration?.phase).toBe("done");
  expect(f.store.trials(job.id)[0]?.history[0]?.outcome.evaluation).toBe("valid");
  expect(f.bench.job(job.id).calibration).toMatchObject({ phase: "done", calibrated: false });
});

it("does not launch a model after adapter planning returns past the deadline", async () => {
  const f = fixture();
  let release: ((value: Awaited<ReturnType<AdapterClient["solve"]>>) => void) | undefined;
  f.solve.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const job = await f.bench.calibrate(f.request);
  await setImmediate();
  const current = f.store.getJob(job.id);
  if (!current) throw new Error("missing job");
  f.store.putJob({ ...current, createdAt: new Date(Date.now() - 21 * 60_000).toISOString() });
  await f.bench.enforceCalibrationBudgets();
  release?.({ spec: { image: "synthetic", command: ["true"] }, issues: [] });
  await setImmediate();
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.bench.job(job.id).calibration?.calibrated).toBe(false);
});
