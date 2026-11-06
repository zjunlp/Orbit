// Explicit terminal-record fixtures; exercises the real store, daemon HTTP API and file deletion.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthStore } from "../src/auth/index.ts";
import { BenchmarkRegistry } from "../src/bench/registry.ts";
import { contentDigest } from "../src/bench/samples.ts";
import { BenchService } from "../src/bench/service.ts";
import { tryConnect } from "../src/client/index.ts";
import { ensureHome, orbitPaths } from "../src/config/paths.ts";
import { BenchJob, Outcome, Run, Trial } from "../src/contracts/index.ts";
import { type StartedDaemon, startDaemon } from "../src/daemon/server.ts";
import { probeNode } from "../src/resources/probe.ts";
import { RunService } from "../src/runs/service.ts";
import { Store } from "../src/store/index.ts";

const homes: string[] = [];
const stores: Store[] = [];
let daemon: StartedDaemon | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  for (const s of stores.splice(0)) s.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

it("rejects a changed preview before mutating jobs, ownership or files", async () => {
  const f = fixture();
  const body = { sources: ["source"], pruneInvalid: true };
  const plan = await f.bench.consolidate("target", body);
  expect(plan.digest).toMatch(/^[a-f0-9]{64}$/);
  expect((await f.bench.consolidate("target", body)).digest).toBe(plan.digest);
  const t = f.store.getTrial("target.b");
  if (!t?.outcome) throw new Error("missing fixture");
  f.store.putTrial({ ...t, outcome: { ...t.outcome, evaluation: "invalid" } });
  const before = f.bench.job("target");
  const changed = await f.bench.consolidate("target", body);
  expect(changed.removedRuns.length).toBeGreaterThan(plan.removedRuns.length);
  expect(changed.digest).not.toBe(plan.digest);
  await expect(
    f.bench.consolidate("target", { ...body, dryRun: false, expect: plan.digest }),
  ).rejects.toThrow("plan changed since preview; preview again");
  expect(f.bench.job("target")).toEqual(before);
  expect(f.store.getJob("source")).not.toBeNull();
  expect(f.store.trialByRun("source.a-solve")?.id).toBe("source.a");
  for (const id of changed.removedRuns) expect(existsSync(join(f.paths.runs, id))).toBe(true);
});

it.each(["valid", "unknown"] as const)(
  "keeps freshly reclassified %s evidence until a later prune",
  async (evaluation) => {
    const f = fixture();
    const run = f.runs.get("target.b-solve"),
      t = f.store.getTrial("target.b");
    if (!run || !t?.outcome) throw new Error("missing fixture");
    f.store.putRun({ ...run, state: "failed", exitCode: 1 });
    const historyRun = { ...run, id: "history-verify" };
    f.store.putRun(historyRun);
    mkdirSync(f.runs.dirs(historyRun.id).output, { recursive: true });
    f.store.putTrial({
      ...t,
      outcome: { ...t.outcome, evaluation },
      history: [{ verifyRunId: historyRun.id, outcome: t.outcome, endedAt: at }],
    });
    const dir = join(f.runs.dirs(run.id).agent, "codex/sessions/2026/10/13");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "rollout-fixture.jsonl"),
      `${JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_complete",
          error: { message: "workspace routing discovery unauthorized (401)" },
        },
      })}\n`,
    );
    const plan = await f.bench.consolidate("target", { pruneInvalid: true });
    expect(plan.reclassified.map((r) => r.trial)).toEqual([t.id]);
    const result = await f.bench.consolidate("target", {
      pruneInvalid: true,
      dryRun: false,
      expect: plan.digest,
    });
    for (const rid of [run.id, t.verifyRunId as string, historyRun.id]) {
      expect(result.removedRuns).not.toContain(rid);
      expect(existsSync(f.runs.dirs(rid).root)).toBe(true);
      expect(f.store.trialByRun(rid)?.id).toBe(t.id);
    }
    expect(f.store.getTrial(t.id)?.history).toHaveLength(1);
    expect(f.store.getTrial(t.id)?.outcome?.evaluation).toBe("invalid");
    const later = await f.bench.consolidate("target", { pruneInvalid: true });
    expect(later.reclassified).toEqual([]);
    expect(later.removedRuns).toEqual(
      expect.arrayContaining([run.id, t.verifyRunId, historyRun.id]),
    );
    await f.bench.consolidate("target", {
      pruneInvalid: true,
      dryRun: false,
      expect: later.digest,
    });
    expect(f.store.getTrial(t.id)?.history).toEqual([]);
    expect(f.store.getRun(run.id)).toBeNull();
  },
);
const at = "2026-10-10T00:00:00.000Z";

it("does not read transport registries when the saved method setup already matches", async () => {
  const f = fixture();
  writeFileSync(f.paths.benchmarks, "malformed registry");
  writeFileSync(f.paths.auth, "malformed registry");
  const plan = await f.bench.consolidate("target", {
    sources: ["source"],
    allowTransportDifferences: true,
  });
  expect(plan.adopted).toHaveLength(1);
});

it.each(
  (["cpus", "memGB", "gpus", "gpuMemGB", "timeoutMin"] as const).flatMap((field) =>
    [false, true].map((planned) => [field, planned] as const),
  ),
)(
  "rejects changed %s budgets (planned=%s) before changing records or artifacts",
  async (field, planned) => {
    const f = fixture(planned);
    const budget = { cpus: 1, memGB: 2, gpus: 0, gpuMemGB: 1, timeoutMin: 1 };
    const snapshot = {
      name: "fixture",
      adapter: "harbor",
      path: f.paths.home,
      config: {},
      env: {},
      passEnv: [],
      resources: join(f.paths.home, "resources.json"),
      createdAt: at,
      updatedAt: at,
    };
    for (const id of ["target", "source"]) {
      const { job } = f.bench.job(id);
      f.store.putJob({
        ...job,
        benchmarkSnapshot: snapshot,
        resources: { a: id === "target" ? budget : { ...budget, [field]: 8 } },
      });
    }
    const before = [f.bench.job("target"), f.bench.job("source")];
    for (const dryRun of [true, false]) {
      await expect(
        f.bench.consolidate("target", {
          sources: ["source"],
          dryRun,
          allowTransportDifferences: true,
        }),
      ).rejects.toThrow(/incompatible.*budget/);
    }
    expect([f.bench.job("target"), f.bench.job("source")]).toEqual(before);
    expect(f.store.trialByRun("source.a-solve")?.id).toBe("source.a");
    expect(readFileSync(join(f.runs.dirs("source.a-solve").output, "answer"), "utf8")).toBe(
      "retained artifact\n",
    );
  },
);

it("uses effective timeout for adopted tasks and retains budgets when appending new tasks", async () => {
  const f = fixture();
  for (const id of ["target", "source"]) {
    const { job } = f.bench.job(id);
    f.store.putJob({
      ...job,
      spec: { ...job.spec, timeoutMin: 5 },
      resources: {
        a: { cpus: 2, timeoutMin: id === "target" ? 1 : 20 },
        [id === "target" ? "b" : "unused"]: { cpus: id === "target" ? 1 : 8 },
      },
    });
  }
  const preview = await f.bench.consolidate("target", { sources: ["source"] });
  expect(preview.adopted).toHaveLength(1);
  await f.bench.consolidate("target", {
    sources: ["source"],
    dryRun: false,
    expect: preview.digest,
  });
  const extra = f.job("extra", ["d"]);
  f.store.putJob({
    ...extra,
    spec: { ...extra.spec, timeoutMin: 5 },
    resources: { d: { cpus: 4, memGB: 8, timeoutMin: 30 } },
  });
  f.trial("extra", "d", true);
  await f.bench.consolidate("target", { sources: ["extra"], appendTasks: true, dryRun: false });
  expect(f.bench.job("target").job.resources?.d).toEqual({ cpus: 4, memGB: 8, timeoutMin: 30 });
});

function fixture(planned = false) {
  const home = mkdtempSync(join(tmpdir(), "orbit-consolidate-"));
  homes.push(home);
  const paths = orbitPaths({ ORBIT_HOME: home });
  ensureHome(paths);
  const store = new Store(paths.db);
  stores.push(store);
  const runs = new RunService({
    store,
    paths,
    probe: () => probeNode(paths.data, { node: paths.node, gpus: paths.gpus }),
  });
  const auth = new AuthStore(paths.auth);
  const registry = new BenchmarkRegistry(paths.benchmarks);
  const bench = new BenchService({
    store,
    paths,
    runs,
    registry,
    auth,
  });
  const items = ["a", "b", "c"].map((taskId) => {
    const content = {
      taskId,
      benchmarkProfile: "synthetic-profile",
      initialStateId: "0",
      initialStateDigest: `sha256:${"a".repeat(64)}`,
      environmentSeed: 7,
      policySeed: 0,
      repetition: 0,
    };
    return { ...content, sampleId: contentDigest(content) };
  });
  const job = (id: string, tasks = ["a"]) => {
    const j = BenchJob.parse({
      id,
      spec: {
        benchmark: "fixture",
        tasks: planned ? items.map((s) => s.taskId) : tasks,
        ...(planned ? { samplePlan: { version: 1, items, digest: contentDigest(items) } } : {}),
        methods: [{ name: "empty", agent: "empty" }],
      },
      folder: id,
      state: "done",
      createdAt: at,
      endedAt: at,
    });
    store.putJob(j);
    return j;
  };
  const trial = (jobId: string, task: string, valid: boolean) => {
    const id = `${jobId}.${task}`;
    for (const phase of ["solve", "verify"]) {
      const rid = `${id}-${phase}`;
      store.putRun(
        Run.parse({
          id: rid,
          spec: {
            command: ["true"],
            backend: "process",
            group: `bench-${jobId}`,
            tags: { job: jobId, trial: id, phase },
          },
          state: "succeeded",
          reason: null,
          exitCode: 0,
          node: "test",
          image: null,
          containerId: null,
          lease: null,
          code: null,
          cleanup: "done",
          sizeBytes: 0,
          note: "",
          folder: jobId,
          createdAt: at,
          startedAt: at,
          endedAt: at,
        }),
      );
      const output = join(paths.runs, rid, "orbit/output");
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, "answer"), "retained artifact\n");
    }
    const t = Trial.parse({
      id,
      jobId,
      task,
      method: "empty",
      ...(planned ? { sampleRef: items.find((s) => s.taskId === task)?.sampleId } : { seed: 1 }),
      state: "done",
      solveRunId: `${id}-solve`,
      verifyRunId: `${id}-verify`,
      outcome: Outcome.parse({
        execution: "succeeded",
        evaluation: valid ? "valid" : "invalid",
        score: valid ? 0 : null,
        maxScore: 1,
        cleanup: "done",
        issues: valid ? [] : ["fixture build failure"],
      }),
      createdAt: at,
      endedAt: at,
    });
    store.putTrial(t);
    return t;
  };
  job("target", ["a", "b", "c"]);
  trial("target", "a", false);
  trial("target", "b", true);
  trial("target", "c", false);
  job("source");
  trial("source", "a", true);
  return { paths, store, runs, bench, job, trial, auth, registry };
}

it("previews without changes; merges zero scores over HTTP while retaining the target matrix and deleting only invalid artifacts", async () => {
  const f = fixture();
  const original = f.bench.job("target");
  f.store.close();
  stores.splice(stores.indexOf(f.store), 1);
  daemon = await startDaemon(f.paths, { port: 0 });
  const c = await tryConnect(f.paths);
  if (!c) throw new Error("daemon unreachable");
  const plan = await c.benchConsolidate("target", { sources: ["source"], pruneInvalid: true });
  expect(plan.adopted).toEqual([
    { task: "a", sourceJob: "source", sourceTrial: "source.a", trial: "target.a" },
  ]);
  expect(plan.removedRuns.sort()).toEqual([
    "target.a-solve",
    "target.a-verify",
    "target.c-solve",
    "target.c-verify",
  ]);
  expect(await c.benchJob("target")).toEqual(original);
  const applied = await c.benchConsolidate("target", {
    sources: ["source"],
    pruneInvalid: true,
    dryRun: false,
    expect: plan.digest,
  });
  expect(applied.digest).toBe(plan.digest);
  expect(applied.leftovers).toEqual([]);
  const result = await c.benchJob("target");
  expect(result.trials.map((t) => t.id)).toEqual(original.trials.map((t) => t.id));
  expect(result.summary[0]).toMatchObject({ trials: 3, valid: 2, invalid: 1 });
  expect(result.summary[0]?.metrics.score?.mean).toBe(0);
  expect(result.trials[2]).toMatchObject({
    solveRunId: null,
    verifyRunId: null,
    outcome: { evaluation: "invalid", issues: ["fixture build failure"] },
  });
  await expect(c.benchJob("source")).rejects.toThrow(/not found/);
  const adopted = await c.get("source.a-solve");
  expect(adopted).toMatchObject({
    folder: "target",
    spec: { group: "bench-target", tags: { trial: "target.a", source_trial: "source.a" } },
  });
  expect(readFileSync(join(f.paths.runs, adopted.id, "orbit/output/answer"), "utf8")).toBe(
    "retained artifact\n",
  );
  for (const id of applied.removedRuns) expect(existsSync(join(f.paths.runs, id))).toBe(false);
  await expect(c.deleteRuns([adopted.id])).rejects.toThrow(/belongs to bench job target/);
  expect(
    (await c.benchConsolidate("target", { pruneInvalid: true, dryRun: false })).removedRuns,
  ).toEqual([]);
});

it("rejects duplicate valid results, incompatible jobs and active runs without partial mutation", async () => {
  const f = fixture();
  f.job("second");
  f.trial("second", "a", true);
  const before = f.bench.job("target");
  await expect(
    f.bench.consolidate("target", { sources: ["source", "second"], dryRun: false }),
  ).rejects.toThrow(/replace valid|duplicate source/);
  expect(f.bench.job("target")).toEqual(before);
  const source = f.store.getJob("source");
  if (!source) throw new Error("missing fixture");
  f.store.putJob({ ...source, spec: { ...source.spec, benchmark: "different" } });
  await expect(
    f.bench.consolidate("target", { sources: ["source"], dryRun: false }),
  ).rejects.toThrow(/incompatible/);
  f.store.putJob(source);
  const run = f.runs.get("source.a-solve");
  if (!run) throw new Error("missing fixture run");
  f.store.putRun({ ...run, state: "running" });
  await expect(
    f.bench.consolidate("target", { sources: ["source"], dryRun: false }),
  ).rejects.toThrow(/running/);
  expect(f.bench.job("target")).toEqual(before);
});

it("prunes invalid scoring history but preserves valid histories and effective zero scores", async () => {
  const f = fixture();
  const old = f.store.getTrial("target.b");
  const bad = f.store.getTrial("target.c");
  if (!old?.outcome || !bad?.outcome) throw new Error("missing fixture");
  // Explicit invalid verifier fixture attached to an otherwise valid trial.
  const rid = "old-invalid-verifier";
  const run = f.runs.get("target.c-verify");
  if (!run) throw new Error("missing fixture run");
  f.store.putRun({ ...run, id: rid });
  f.store.putTrial({
    ...old,
    history: [
      { verifyRunId: rid, outcome: bad.outcome, endedAt: at },
      { verifyRunId: null, outcome: old.outcome, endedAt: at },
    ],
  });
  const out = await f.bench.consolidate("target", { pruneInvalid: true, dryRun: false });
  expect(out.removedRuns).toContain(rid);
  expect(out.removedRuns).not.toContain("target.b-solve");
  expect(f.store.getTrial(old.id)?.history).toHaveLength(1);
});

it("appends completed tasks over HTTP, retaining invalid scores and artifacts without changing old trials", async () => {
  const f = fixture();
  f.job("extra", ["d", "e"]);
  f.trial("extra", "d", true);
  const invalid = f.trial("extra", "e", false);
  if (!invalid.outcome) throw new Error("missing outcome");
  f.store.putTrial({ ...invalid, outcome: { ...invalid.outcome, score: 1 } });
  const before = f.bench.job("target");
  f.store.close();
  stores.splice(stores.indexOf(f.store), 1);
  daemon = await startDaemon(f.paths, { port: 0 });
  const c = await tryConnect(f.paths);
  if (!c) throw new Error("daemon unreachable");
  await expect(c.benchConsolidate("target", { sources: ["extra"] })).rejects.toThrow(
    /target matrix/,
  );
  const body = { sources: ["extra"], appendTasks: true };
  const plan = await c.benchConsolidate("target", body);
  expect(plan.removedRuns).toEqual([]);
  expect(plan.adopted.map((a) => a.task)).toEqual(["d", "e"]);
  expect(await c.benchJob("target")).toEqual(before);
  await c.benchConsolidate("target", { ...body, dryRun: false });
  const after = await c.benchJob("target");
  expect(after.job.spec.tasks).toEqual(["a", "b", "c", "d", "e"]);
  expect(after.trials.filter((t) => before.trials.some((b) => b.id === t.id))).toEqual(
    before.trials,
  );
  expect(after.summary[0]).toMatchObject({ trials: 5, valid: 2, invalid: 3 });
  const imported = after.trials.find((t) => t.task === "e");
  expect(imported).toMatchObject({
    solveRunId: invalid.solveRunId,
    outcome: { ...invalid.outcome, score: 1 },
  });
  expect(await c.get("extra.e-solve")).toMatchObject({
    folder: "target",
    spec: { group: "bench-target", tags: { source_job: "extra", source_benchmark: "fixture" } },
  });
  expect(readFileSync(join(f.paths.runs, "extra.e-solve", "orbit/output/answer"), "utf8")).toBe(
    "retained artifact\n",
  );
  await expect(c.benchJob("extra")).rejects.toThrow(/not found/);
});

it("allows explicitly requested transport aliases only for the same checkout, credential and method", async () => {
  const f = fixture();
  const env = { HTTPS_PROXY: "http://localhost:8888", TASK_MODE: "fixed" };
  f.registry.put({ name: "fixture", adapter: "harbor", path: f.paths.home, env });
  f.registry.put({
    name: "bridge",
    adapter: "harbor",
    path: f.paths.home,
    env: { ...env, HTTPS_PROXY: "http://172.17.0.1:8888" },
  });
  const credential = {
    harness: "codex" as const,
    kind: "login" as const,
    secret: JSON.stringify({ tokens: { access_token: "explicit-fixture-token" } }),
  };
  f.auth.put({ ...credential, name: "host", hostNetwork: true });
  f.auth.put({ ...credential, name: "bridge", hostNetwork: false });
  const method = {
    name: "empty",
    agent: "codex" as const,
    auth: "host",
    model: "fixture-model",
    effort: "max",
  };
  const source = { commit: "same-snapshot", describe: null, dirty: false };
  const a = f.job("aliases-target"),
    b = f.job("aliases-source", ["b"]);
  f.trial(a.id, "a", true);
  f.trial(b.id, "b", false);
  f.store.putJob({ ...a, source, spec: { ...a.spec, methods: [method] } });
  const donor = {
    ...b,
    source,
    spec: { ...b.spec, benchmark: "bridge", methods: [{ ...method, auth: "bridge" }] },
  };
  f.store.putJob(donor);
  const body = { sources: [b.id], appendTasks: true, allowTransportDifferences: true };
  await expect(
    f.bench.consolidate(a.id, { ...body, allowTransportDifferences: false }),
  ).rejects.toThrow(/incompatible/);
  expect((await f.bench.consolidate(a.id, body)).adopted).toHaveLength(1);
  for (const bad of [
    { ...donor, source: { ...source, commit: "different" } },
    { ...donor, spec: { ...donor.spec, seeds: 2, samplePlan: undefined, batchSize: undefined } },
    {
      ...donor,
      spec: { ...donor.spec, methods: [{ ...method, auth: "bridge", model: "different" }] },
    },
  ]) {
    f.store.putJob(bad);
    await expect(f.bench.consolidate(a.id, body)).rejects.toThrow(/incompatible/);
  }
  f.store.putJob(donor);
  f.auth.put({
    ...credential,
    name: "bridge",
    secret: JSON.stringify({ tokens: { access_token: "different-fixture-token" } }),
  });
  await expect(f.bench.consolidate(a.id, body)).rejects.toThrow(/incompatible/);
  f.auth.put({ ...credential, name: "bridge" });
  f.registry.put({
    name: "bridge",
    adapter: "harbor",
    path: f.paths.home,
    env: { TASK_MODE: "different" },
  });
  await expect(f.bench.consolidate(a.id, body)).rejects.toThrow(/incompatible/);
});

it("refuses duplicate appended tasks and pruning during append without changing either job", async () => {
  const f = fixture();
  f.job("first", ["new"]);
  f.trial("first", "new", false);
  f.job("second", ["new"]);
  f.trial("second", "new", true);
  const before = f.bench.job("target");
  await expect(
    f.bench.consolidate("target", {
      sources: ["first", "second"],
      appendTasks: true,
      dryRun: false,
    }),
  ).rejects.toThrow(/duplicate appended/);
  await expect(
    f.bench.consolidate("target", { sources: ["first"], appendTasks: true, pruneInvalid: true }),
  ).rejects.toThrow(/preserves invalid/);
  expect(f.bench.job("target")).toEqual(before);
  expect(f.bench.job("first").trials).toHaveLength(1);
});

it.each(["failed", "succeeded"] as const)(
  "reconciles terminal Agent errors in a %s solve before replacing a valid zero",
  async (state) => {
    const f = fixture();
    f.job("retry-b", ["b"]);
    f.trial("retry-b", "b", true);
    const run = f.runs.get("target.b-solve"),
      trial = f.store.getTrial("target.b");
    if (!run || !trial?.outcome) throw new Error("missing fixture");
    f.store.putRun({ ...run, state, exitCode: state === "failed" ? 1 : 0 });
    f.store.putTrial({
      ...trial,
      history: [{ verifyRunId: null, outcome: trial.outcome, endedAt: at }],
    });
    const dir = join(f.runs.dirs(run.id).agent, "codex/sessions/2026/10/13");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "rollout-fixture.jsonl");
    const done = (error: unknown) =>
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", error } });
    writeFileSync(file, `${done({ message: "workspace routing discovery timed out" })}\n`);
    const before = f.bench.job("target");
    const plan = await f.bench.consolidate("target", { sources: ["retry-b"] });
    expect(plan.adopted.map((a) => a.task)).toEqual(["b"]);
    expect(plan.reclassified).toEqual([
      { job: "target", trial: trial.id, task: "b", kind: "model_unreachable" },
    ]);
    expect(f.bench.job("target")).toEqual(before);
    // A recovered later turn and ordinary experiment failures must retain the valid-score guard.
    for (const text of [
      `${done({ message: "workspace routing discovery timed out" })}\n${done(null)}\n`,
      `${done({ message: "pytest assertion failed" })}\n`,
    ]) {
      writeFileSync(file, text);
      await expect(
        f.bench.consolidate("target", { sources: ["retry-b"], dryRun: false }),
      ).rejects.toThrow(/replace valid/);
    }
    writeFileSync(file, `${done({ message: "workspace routing discovery timed out" })}\n`);
    await f.bench.consolidate("target", { sources: ["retry-b"], dryRun: false });
    expect(f.store.getTrial(trial.id)).toMatchObject({
      solveRunId: "retry-b.b-solve",
      outcome: { evaluation: "valid", score: 0 },
    });
    expect(f.bench.job("target").trials).toHaveLength(3);
  },
);

it.each(["cancelled", "lost", "unstarted", "after"] as const)(
  "only reclassifies model failures in scoreable solves: %s",
  async (kind) => {
    const f = fixture();
    const run = f.runs.get("target.b-solve");
    if (!run) throw new Error("missing fixture");
    f.store.putRun({
      ...run,
      state: kind === "cancelled" || kind === "lost" ? kind : "failed",
      startedAt: kind === "unstarted" ? null : run.startedAt,
      spec: {
        ...run.spec,
        ...(kind === "after"
          ? {
              backend: "docker",
              image: "fixture",
              after: {
                command: ["true"],
                timeoutMin: 1,
                env: {},
                passEnv: [],
                copy: [],
                collect: [],
              },
            }
          : {}),
      },
    });
    const dir = join(f.runs.dirs(run.id).agent, "codex/sessions/2026/10/16");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "rollout-fixture.jsonl"),
      `${JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_complete",
          error: { message: "workspace routing discovery failed" },
        },
      })}\n`,
    );
    const before = f.bench.job("target");
    const result = await f.bench.consolidate("target", { dryRun: false });
    if (kind === "after") {
      expect(result.reclassified).toEqual([
        { job: "target", trial: "target.b", task: "b", kind: "model_unreachable" },
      ]);
      const previous = before.trials.find((t) => t.id === "target.b")?.outcome;
      expect(f.store.getTrial("target.b")?.outcome).toMatchObject({
        evaluation: "invalid",
        failure: "model_unavailable",
        score: previous?.score,
      });
    } else {
      expect(result.reclassified).toEqual([]);
      expect(f.bench.job("target")).toEqual(before);
    }
  },
);

it("marks an unknown outcome invalid without sources when its Agent could not work", async () => {
  const f = fixture();
  const run = f.runs.get("target.b-solve"),
    trial = f.store.getTrial("target.b");
  if (!run || !trial?.outcome) throw new Error("missing fixture");
  f.store.putRun({ ...run, state: "failed", exitCode: 1, reason: "exit code 1" });
  const lost = { ...trial.outcome, evaluation: "unknown" as const, issues: ["verify lost"] };
  f.store.putTrial({ ...trial, outcome: lost });
  const dir = join(f.runs.dirs(run.id).agent, "codex/sessions/2026/10/13");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "rollout-fixture.jsonl"),
    `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", error: { message: "unexpected status 401 Unauthorized", codex_error_info: { http_connection_failed: { http_status_code: 401 } } } } })}\n`,
  );
  const plan = await f.bench.consolidate("target", {});
  expect(plan.reclassified.map((r) => [r.task, r.kind])).toEqual([
    ["b", "model_authentication_failed"],
  ]);
  expect(f.store.getTrial(trial.id)?.outcome?.evaluation).toBe("unknown");
  const result = await f.bench.consolidate("target", { dryRun: false });
  expect(result.removedRuns).toEqual([]);
  expect(f.store.getTrial(trial.id)?.outcome).toMatchObject({
    evaluation: "invalid",
    issues: [
      "verify lost",
      "Agent stopped: model_authentication_failed (unexpected status 401 Unauthorized)",
    ],
  });
});

it("rejects a donor whose valid mark hides a terminal model failure", async () => {
  const f = fixture();
  const run = f.runs.get("source.a-solve");
  if (!run) throw new Error("missing fixture");
  f.store.putRun({ ...run, state: "failed", exitCode: 1 });
  const dir = join(f.runs.dirs(run.id).agent, "codex/sessions/2026/10/13");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "rollout-fixture.jsonl"),
    `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", error: { message: "workspace routing discovery unauthorized (401)" } } })}\n`,
  );
  await expect(
    f.bench.consolidate("target", { sources: ["source"], dryRun: false }),
  ).rejects.toThrow(/no valid result/);
  await expect(
    f.bench.consolidate("target", { sources: ["source"], pruneInvalid: true, dryRun: false }),
  ).rejects.toThrow(/no valid result/);
  expect(f.store.getJob("source")).not.toBeNull();
  expect(existsSync(f.runs.dirs(run.id).output)).toBe(true);
});

it("refuses pruning a newly reclassified target while also replacing its solve", async () => {
  const f = fixture();
  f.job("retry-b", ["b"]);
  f.trial("retry-b", "b", true);
  const run = f.runs.get("target.b-solve");
  if (!run) throw new Error("missing fixture");
  f.store.putRun({ ...run, state: "failed", exitCode: 1 });
  const dir = join(f.runs.dirs(run.id).agent, "codex/sessions/2026/10/13");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "rollout-fixture.jsonl"),
    `${JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_complete",
        error: { message: "workspace routing discovery unauthorized (401)" },
      },
    })}\n`,
  );
  const before = f.bench.job("target");
  await expect(
    f.bench.consolidate("target", {
      sources: ["retry-b"],
      pruneInvalid: true,
      dryRun: false,
    }),
  ).rejects.toThrow(/just reclassified.*review/);
  expect(f.bench.job("target")).toEqual(before);
  expect(existsSync(f.runs.dirs(run.id).output)).toBe(true);
});

it("replaces a scored failed solve only by opt-in over HTTP, regardless of score", async () => {
  const f = fixture();
  f.job("retry-b", ["b"]);
  f.trial("retry-b", "b", true);
  const run = f.runs.get("target.b-solve"),
    trial = f.store.getTrial("target.b");
  if (!run || !trial?.outcome) throw new Error("missing fixture");
  f.store.putRun({ ...run, state: "failed", reason: "timeout after 480 min", exitCode: 143 });
  const outcome = { ...trial.outcome, execution: "failed", score: 1, issues: ["solve timed out"] };
  f.store.putTrial({ ...trial, outcome, history: [{ verifyRunId: null, outcome, endedAt: at }] });
  const before = f.bench.job("target");
  f.store.close();
  stores.splice(stores.indexOf(f.store), 1);
  daemon = await startDaemon(f.paths, { port: 0 });
  const c = await tryConnect(f.paths);
  if (!c) throw new Error("daemon unreachable");
  await expect(c.benchConsolidate("target", { sources: ["retry-b"] })).rejects.toThrow(
    /replace valid/,
  );
  const body = { sources: ["retry-b"], replaceFailed: true };
  expect((await c.benchConsolidate("target", body)).adopted.map((t) => t.task)).toEqual(["b"]);
  expect(await c.benchJob("target")).toEqual(before);
  const result = await c.benchConsolidate("target", { ...body, dryRun: false });
  expect(result.leftovers).toEqual([]);
  const after = await c.benchJob("target");
  expect(after.trials.find((t) => t.task === "b")).toMatchObject({
    id: trial.id,
    solveRunId: "retry-b.b-solve",
    outcome: { execution: "succeeded", evaluation: "valid", score: 0 },
  });
  expect(after.trials.filter((t) => t.task !== "b")).toEqual(
    before.trials.filter((t) => t.task !== "b"),
  );
  expect(readFileSync(join(f.paths.runs, "retry-b.b-solve/orbit/output/answer"), "utf8")).toContain(
    "retained artifact",
  );
  expect((await c.get("retry-b.b-solve")).spec.tags.source_job).toBe("retry-b");
  expect(existsSync(join(f.paths.runs, run.id))).toBe(false);
});

it.each(["succeeded", "failed"] as const)(
  "retains a completed invalid retry with a %s solve over a non-valid target without pruning",
  async (state) => {
    const f = fixture();
    const retry = f.trial("source", "a", false),
      verify = f.runs.get("source.a-verify");
    if (!retry.outcome || !verify) throw new Error("missing fixture");
    const solve = f.runs.get(retry.solveRunId as string);
    if (!solve) throw new Error("missing fixture solve");
    f.store.putRun({ ...solve, state });
    const outcome = { ...retry.outcome, execution: state, score: 0, issues: ["verify timed out"] };
    f.store.putTrial({ ...retry, outcome });
    f.store.putRun({ ...verify, state: "failed", reason: "timeout after 10 min", exitCode: 143 });
    const before = f.bench.job("target");
    await expect(f.bench.consolidate("target", { sources: ["source"] })).rejects.toThrow(
      /no valid result/,
    );
    const body = { sources: ["source"], replaceFailed: true };
    expect((await f.bench.consolidate("target", body)).adopted).toHaveLength(1);
    expect(f.bench.job("target")).toEqual(before);
    await f.bench.consolidate("target", { ...body, dryRun: false });
    expect(f.store.getTrial("target.a")).toMatchObject({
      solveRunId: retry.solveRunId,
      verifyRunId: retry.verifyRunId,
      outcome,
    });
    expect(f.runs.get(retry.solveRunId as string)?.spec.tags.source_job).toBe("source");
    expect(existsSync(join(f.paths.runs, verify.id, "orbit/output/answer"))).toBe(true);
    expect(f.store.getJob("source")).toBeNull();
  },
);

it("protects valid targets and rejects lost or cancelled replacement solves, pruning and duplicate sources", async () => {
  const f = fixture();
  f.job("retry-b", ["b"]);
  f.trial("retry-b", "b", true);
  const before = f.bench.job("target");
  await expect(
    f.bench.consolidate("target", { sources: ["retry-b"], replaceFailed: true, dryRun: false }),
  ).rejects.toThrow(/replace valid/);
  await expect(
    f.bench.consolidate("target", {
      sources: ["source"],
      replaceFailed: true,
      pruneInvalid: true,
      dryRun: false,
    }),
  ).rejects.toThrow(/preserves retry artifacts/);
  const source = f.trial("source", "a", false),
    run = f.runs.get("source.a-solve");
  if (!source.outcome || !run) throw new Error("missing fixture");
  for (const state of ["lost", "cancelled"] as const) {
    f.store.putRun({ ...run, state });
    await expect(
      f.bench.consolidate("target", { sources: ["source"], replaceFailed: true, dryRun: false }),
    ).rejects.toThrow(/no valid result/);
  }
  f.store.putRun(run);
  const target = f.store.getTrial("target.a");
  const protectedOutcome = f.store.getTrial("target.b")?.outcome;
  if (!target || !protectedOutcome) throw new Error("missing fixture target");
  for (const validHistory of [false, true]) {
    f.store.putTrial({
      ...target,
      outcome: validHistory ? target.outcome : protectedOutcome,
      history: validHistory ? [{ verifyRunId: null, outcome: protectedOutcome, endedAt: at }] : [],
    });
    await expect(
      f.bench.consolidate("target", { sources: ["source"], replaceFailed: true, dryRun: false }),
    ).rejects.toThrow(/no valid result|replace valid/);
  }
  f.store.putTrial(target);
  f.store.putTrial({ ...source, outcome: { ...source.outcome, evaluation: "unknown" } });
  await expect(
    f.bench.consolidate("target", { sources: ["source"], replaceFailed: true, dryRun: false }),
  ).rejects.toThrow(/no valid result/);
  f.store.putTrial(source);
  f.job("second", ["a"]);
  f.trial("second", "a", false);
  await expect(
    f.bench.consolidate("target", {
      sources: ["source", "second"],
      replaceFailed: true,
      dryRun: false,
    }),
  ).rejects.toThrow(/duplicate source/);
  expect(f.bench.job("target")).toEqual(before);
});
