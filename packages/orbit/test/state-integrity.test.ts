import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { BenchmarkRegistry } from "../src/bench/registry.ts";
import { BenchService } from "../src/bench/service.ts";
import { ensureHome, orbitPaths } from "../src/config/paths.ts";
import { BenchJob, Outcome, Run, Trial } from "../src/contracts/index.ts";
import { RunService } from "../src/runs/service.ts";
import { Store } from "../src/store/index.ts";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, rmSync: vi.fn(fs.rmSync) };
});

const homes: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) s.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "orbit-integrity-"));
  homes.push(home);
  const paths = orbitPaths({ ORBIT_HOME: join(home, "state") });
  ensureHome(paths);
  const store = new Store(paths.db);
  stores.push(store);
  const runs = new RunService({ store, paths, probe: vi.fn() });
  const registry = new BenchmarkRegistry(paths.benchmarks);
  registry.put({ name: "fixture", path: home, adapter: "harbor" });
  const log = vi.fn();
  const bench = new BenchService({ store, paths, runs, registry, log });
  const at = "2026-10-16T00:00:00.000Z";
  const job = BenchJob.parse({
    id: "job",
    spec: { benchmark: "fixture", methods: [{ name: "empty", agent: "empty" }] },
    state: "done",
    createdAt: at,
    endedAt: at,
  });
  const trial = Trial.parse({
    id: "job.1",
    jobId: job.id,
    task: "a",
    method: "empty",
    seed: 1,
    state: "done",
    solveRunId: "solve",
    verifyRunId: "verify",
    createdAt: at,
    endedAt: at,
    outcome: Outcome.parse({
      execution: "succeeded",
      evaluation: "valid",
      score: 1,
      maxScore: 1,
      issues: [],
      cleanup: "pending",
    }),
  });
  const run = Run.parse({
    id: "solve",
    spec: { command: ["true"], backend: "process" },
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
    folder: "fixture",
    createdAt: at,
    startedAt: at,
    endedAt: at,
  });
  return { home, paths, store, runs, bench, log, job, trial, run };
}

it("delivers run changes after the outer commit, allowing a listener to write a trial", () => {
  const f = fixture();
  f.store.putRun(f.run);
  const reader = new Store(f.paths.db);
  stores.push(reader);
  const seen: string[] = [];
  f.runs.on("change", ({ run }) => {
    expect(reader.getRun(run.id)?.note).toBe("committed");
    f.store.putTrial(f.trial);
    seen.push(run.note);
  });
  f.store.tx(() => {
    f.store.tx(() => f.runs.setNote(f.run.id, "committed"));
    expect(seen).toEqual([]);
    expect(reader.getRun(f.run.id)?.note).toBe("");
  });
  expect(seen).toEqual(["committed"]);
  expect(f.store.getTrial(f.trial.id)).toEqual(f.trial);
});

it("rolls back nested writes and notifications without losing the outer transaction", () => {
  const f = fixture();
  f.store.putRun(f.run);
  const change = vi.fn();
  f.runs.on("change", change);
  f.store.tx(() => {
    expect(() =>
      f.store.tx(() => {
        f.runs.setNote(f.run.id, "discarded");
        throw new Error("nested failure");
      }),
    ).toThrow("nested failure");
    expect(f.store.getRun(f.run.id)?.note).toBe("");
    f.runs.setNote(f.run.id, "kept");
  });
  expect(change).toHaveBeenCalledTimes(1);
  expect(() =>
    f.store.tx(() => {
      f.store.tx(() => f.runs.setNote(f.run.id, "also discarded"));
      throw new Error("outer failure");
    }),
  ).toThrow("outer failure");
  expect(change).toHaveBeenCalledTimes(1);
  expect(f.store.getRun(f.run.id)?.note).toBe("kept");
});

it("does not roll back committed data or drop later callbacks when a listener throws", () => {
  const { store, run } = fixture();
  const last = vi.fn();
  expect(() =>
    store.tx(() => {
      store.putRun(run);
      store.afterCommit(() => {
        throw new Error("listener failed");
      });
      store.afterCommit(last);
    }),
  ).toThrow("after-commit callback failed");
  expect(store.getRun(run.id)).toEqual(run);
  expect(last).toHaveBeenCalledOnce();
  store.tx(() => store.putRun({ ...run, note: "next transaction" }));
});

it("repairs finished cleanup at startup, includes history, and is idempotent", () => {
  const f = fixture();
  f.store.putJob(f.job);
  f.store.putRun(f.run);
  f.store.putRun({ ...f.run, id: "verify" });
  f.store.putTrial(f.trial);
  f.store.putRun({ ...f.run, id: "old", cleanup: "pending" });
  f.store.putTrial({
    ...f.trial,
    id: "history",
    history: [{ verifyRunId: "old", outcome: f.trial.outcome as Outcome, endedAt: null }],
  });
  f.store.putRun({ ...f.run, id: "bad", cleanup: "failed" });
  f.store.putTrial({ ...f.trial, id: "failed", solveRunId: "bad", verifyRunId: null });
  f.bench.start();
  expect(f.store.getTrial(f.trial.id)?.outcome?.cleanup).toBe("done");
  expect(f.store.getTrial("history")?.outcome?.cleanup).toBe("pending");
  expect(f.store.getTrial("failed")?.outcome?.cleanup).toBe("failed");
  expect(f.log).toHaveBeenCalledWith(expect.stringContaining(f.trial.id));
  expect(f.log).toHaveBeenCalledTimes(2);
  f.bench.start();
  expect(f.log).toHaveBeenCalledTimes(2);
});

it("refuses a newer database without migrating or changing its version", () => {
  const f = fixture();
  const file = join(f.home, "newer.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA user_version = 9999");
  expect(() => new Store(file)).toThrow(/newer.*update Orbit/);
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(9999);
  expect(db.prepare("SELECT name FROM sqlite_master").all()).toEqual([]);
  db.close();
});

function legacyDatabase(file: string, job: BenchJob, trial: Trial) {
  const initial = new Store(file);
  initial.putJob(job);
  initial.putTrial(trial);
  initial.close();
  const legacy = new DatabaseSync(file);
  legacy.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
    DROP TABLE trial_runs;
    CREATE TABLE trial_runs (run_id TEXT PRIMARY KEY, trial_id TEXT NOT NULL);
    CREATE INDEX trial_runs_trial ON trial_runs(trial_id);
    INSERT INTO trial_runs VALUES ('solve', 'job.1'), ('verify', 'job.1');
    PRAGMA user_version = 6;`);
  return legacy;
}

it("backs up committed WAL before migrating and restores legacy jobs, trials and history", () => {
  const f = fixture();
  const file = join(f.home, "legacy.db");
  const history = { verifyRunId: "old-verify", outcome: f.trial.outcome as Outcome, endedAt: null };
  const trial = { ...f.trial, history: [history] };
  const legacy = legacyDatabase(file, f.job, trial);
  legacy.prepare("INSERT INTO trial_runs VALUES (?, ?)").run("old-verify", trial.id);
  const changed = { ...f.job, spec: { ...f.job.spec, name: "committed in WAL" } };
  legacy
    .prepare("UPDATE bench_jobs SET doc = ? WHERE id = ?")
    .run(JSON.stringify(changed), changed.id);
  expect(existsSync(`${file}-wal`)).toBe(true);
  const migrated = new Store(file);
  stores.push(migrated);
  legacy.close();
  expect(migrated.getJob(changed.id)).toEqual(changed);
  expect(migrated.getTrial(trial.id)).toEqual(trial);
  expect(migrated.trialsByRun("old-verify", "verify")).toEqual([trial]);
  expect(migrated.trialsByRun("solve", "solve")).toEqual([trial]);
  const backup = migrated.migrationBackup;
  if (!backup) throw new Error("missing pre-migration backup");
  expect(statSync(backup).mode & 0o777).toBe(0o600);
  const snapshot = new DatabaseSync(backup, { readOnly: true });
  expect(snapshot.prepare("PRAGMA user_version").get()?.user_version).toBe(6);
  expect(JSON.parse(String(snapshot.prepare("SELECT doc FROM bench_jobs").get()?.doc))).toEqual(
    changed,
  );
  snapshot.close();
  const restored = join(f.home, "restored.db");
  copyFileSync(backup, restored);
  const recovery = new Store(restored);
  stores.push(recovery);
  expect(recovery.getJob(changed.id)).toEqual(changed);
  expect(recovery.getTrial(trial.id)).toEqual(trial);
});

it("rolls back a failed migration and keeps an independently readable pre-migration backup", () => {
  const f = fixture();
  const file = join(f.home, "failed-migration.db");
  const legacy = legacyDatabase(file, f.job, f.trial);
  legacy.exec("CREATE TABLE trial_runs_legacy (collision TEXT)");
  expect(() => new Store(file)).toThrow(/already another table/);
  // A supervisor retrying the start replaces the backup instead of adding full copies.
  expect(() => new Store(file)).toThrow(/already another table/);
  expect(legacy.prepare("PRAGMA user_version").get()?.user_version).toBe(6);
  expect(legacy.prepare("SELECT * FROM trial_runs").all()).toHaveLength(2);
  legacy.close();
  const backups = readdirSync(`${file}.backups`);
  expect(backups).toEqual(["v6.sqlite"]);
  const backup = new DatabaseSync(join(`${file}.backups`, backups[0] as string), {
    readOnly: true,
  });
  expect(backup.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
  expect(backup.prepare("PRAGMA user_version").get()?.user_version).toBe(6);
  expect(JSON.parse(String(backup.prepare("SELECT doc FROM trials").get()?.doc))).toEqual(f.trial);
  backup.close();
});

it("rolls back the job and all trials when submission fails midway", async () => {
  const f = fixture();
  vi.spyOn(f.bench, "infoOf").mockResolvedValue({
    tasks: [{ id: "a", title: null, supported: true, reason: null, tags: {} }],
    metrics: [],
  });
  const put = f.store.putTrial.bind(f.store);
  vi.spyOn(f.store, "putTrial")
    .mockImplementationOnce(put)
    .mockImplementationOnce(() => {
      throw new Error("injected trial write failure");
    });
  await expect(
    f.bench.submit({
      benchmark: "fixture",
      seeds: 3,
      methods: [{ name: "empty", agent: "empty" }],
    }),
  ).rejects.toThrow("injected trial write failure");
  expect(f.store.listJobs()).toEqual([]);
  expect(f.store.openTrials()).toEqual([]);
  expect(f.store.db.prepare("SELECT * FROM trial_runs").all()).toEqual([]);
});

it("finishes the job even when removing staging fails", async () => {
  const f = fixture();
  f.store.putJob({ ...f.job, state: "running", endedAt: null });
  f.store.putTrial({ ...f.trial, state: "solving", outcome: null, endedAt: null });
  f.store.putRun({ ...f.run, state: "cancelled" });
  // Explicit permission failure; chmod-based fixtures do not fail when tests run as root.
  vi.mocked(rmSync).mockImplementationOnce(() => {
    throw new Error("EACCES: staging removal denied");
  });
  f.bench.start();
  await expect.poll(() => f.store.getJob(f.job.id)?.state).toBe("done");
  expect(f.store.getTrial(f.trial.id)?.state).toBe("done");
  expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/job\.1.*staging cleanup.*EACCES/));
});

it("skips failed folder copies without writing metadata or counting the run", async () => {
  const f = fixture();
  f.store.putRun(f.run);
  f.store.putRun({ ...f.run, id: "missing" });
  mkdirSync(f.runs.dirs(f.run.id).root, { recursive: true });
  writeFileSync(join(f.runs.dirs(f.run.id).root, "artifact"), "ok");
  const dest = join(f.home, "export");
  const result = await f.bench.exportFolder("fixture", dest);
  expect(result.runs).toBe(1);
  expect(result.skipped).toEqual([expect.stringContaining("missing:")]);
  expect(existsSync(join(dest, "runs/missing/run.json"))).toBe(false);
  expect(readFileSync(join(dest, "runs/solve/artifact"), "utf8")).toBe("ok");
});
