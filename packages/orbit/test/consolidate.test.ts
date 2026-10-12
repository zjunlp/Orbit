// Explicit terminal-record fixtures; exercises the real store, daemon HTTP API and file deletion.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthStore } from "../src/auth/index.ts";
import { BenchmarkRegistry } from "../src/bench/registry.ts";
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
const at = "2026-10-10T00:00:00.000Z";
function fixture() {
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
  const job = (id: string, tasks = ["a"]) => {
    const j = BenchJob.parse({
      id,
      spec: { benchmark: "fixture", tasks, methods: [{ name: "empty", agent: "empty" }] },
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
      seed: 1,
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
  });
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
  ).rejects.toThrow(/replace valid/);
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
    { ...donor, spec: { ...donor.spec, seeds: 2 } },
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
