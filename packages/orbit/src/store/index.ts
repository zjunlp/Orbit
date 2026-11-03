import { closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  BenchJob,
  type BenchReport,
  BenchReport as BenchReportSchema,
  type FolderStat,
  Lease,
  type MethodSummary,
  Run,
  type RunCursor,
  RunEvent,
  type RunState,
  Trial,
  trialRunIds,
} from "../contracts/index.ts";
import { aggregate, resolveMetrics, taskMeans } from "../contracts/metrics.ts";
import { nowIso } from "../lib/ids.ts";

const MIGRATIONS = [
  `CREATE TABLE runs (
     id TEXT PRIMARY KEY,
     state TEXT NOT NULL,
     grp TEXT,
     created_at TEXT NOT NULL,
     doc TEXT NOT NULL
   );
   CREATE INDEX runs_state ON runs(state);
   CREATE INDEX runs_created ON runs(created_at);
   CREATE TABLE leases (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL,
     state TEXT NOT NULL,
     doc TEXT NOT NULL
   );
   CREATE INDEX leases_state ON leases(state);
   CREATE TABLE events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id TEXT NOT NULL,
     at TEXT NOT NULL,
     kind TEXT NOT NULL,
     message TEXT NOT NULL
   );
   CREATE INDEX events_run ON events(run_id, seq);`,
  `CREATE TABLE bench_jobs (
     id TEXT PRIMARY KEY,
     state TEXT NOT NULL,
     created_at TEXT NOT NULL,
     doc TEXT NOT NULL
   );
   CREATE TABLE trials (
     id TEXT PRIMARY KEY,
     job_id TEXT NOT NULL,
     state TEXT NOT NULL,
     solve_run TEXT,
     verify_run TEXT,
     doc TEXT NOT NULL
   );
   CREATE INDEX trials_job ON trials(job_id);
   CREATE INDEX trials_state ON trials(state);`,
  // A run placed on another node: how far its events and records have been mirrored.
  `CREATE TABLE remote_sync (
     run_id TEXT PRIMARY KEY,
     node TEXT NOT NULL,
     event_seq INTEGER NOT NULL DEFAULT 0,
     confirmed INTEGER NOT NULL DEFAULT 0,
     cancel INTEGER NOT NULL DEFAULT 0,
     done INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX remote_sync_open ON remote_sync(done);`,
  // Every run a trial has had, including verify runs replaced by a rescore.
  `CREATE TABLE trial_runs (
     run_id TEXT PRIMARY KEY,
     trial_id TEXT NOT NULL
   );
   CREATE INDEX trial_runs_trial ON trial_runs(trial_id);
   INSERT OR IGNORE INTO trial_runs SELECT solve_run, id FROM trials WHERE solve_run IS NOT NULL;
   INSERT OR IGNORE INTO trial_runs SELECT verify_run, id FROM trials WHERE verify_run IS NOT NULL;`,
  `CREATE INDEX trials_open_job ON trials(job_id) WHERE state != 'done';`,
  `CREATE TABLE bench_reports (
     job_id TEXT NOT NULL,
     revision INTEGER NOT NULL,
     doc TEXT NOT NULL,
     PRIMARY KEY (job_id, revision)
   );`,
];

/** Mirroring progress of a run placed on another node (primary only). */
export interface RemoteSync {
  runId: string;
  node: string;
  /** Last event seq copied from the worker. */
  eventSeq: number;
  /** The worker has acknowledged the run. */
  confirmed: boolean;
  /** Cancellation requested and not yet acknowledged by a terminal state. */
  cancel: boolean;
  /** Terminal, cleaned up and fully mirrored: nothing more to fetch. */
  done: boolean;
}

export interface RunFilter {
  before?: RunCursor;
  states?: RunState[];
  group?: string;
  /** This folder and its subfolders. */
  folder?: string;
  limit?: number;
}

const FOLDER = "COALESCE(json_extract(doc, '$.folder'), '')";
/** `folder` or inside it, as SQL on `FOLDER` with two parameters. */
const IN_FOLDER = `(${FOLDER} = ? OR substr(${FOLDER}, 1, length(?) + 1) = ? || '/')`;

/** Typed access to the local sqlite database. Only the daemon opens it. */
export class Store {
  readonly db: DatabaseSync;
  private readonly commits: (() => void)[][] = [];

  constructor(file: string) {
    if (file !== ":memory:") {
      try {
        closeSync(openSync(file, "wx", 0o600));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    this.db = new DatabaseSync(file);
    try {
      this.db.exec("PRAGMA busy_timeout = 5000;");
      this.migrate();
      this.db.exec("PRAGMA journal_mode = WAL;");
    } catch (e) {
      this.db.close();
      throw e;
    }
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (row.user_version > MIGRATIONS.length)
      throw new Error(`database version ${row.user_version} is newer than supported; update Orbit`);
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[v] as string);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
  }

  close(): void {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    const depth = this.commits.length;
    const savepoint = `orbit_tx_${depth}`;
    this.db.exec(depth ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    const callbacks: (() => void)[] = [];
    this.commits.push(callbacks);
    let out: T;
    try {
      out = fn();
      this.db.exec(depth ? `RELEASE ${savepoint}` : "COMMIT");
    } catch (e) {
      this.db.exec(depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
      throw e;
    } finally {
      this.commits.pop();
    }
    const parent = this.commits.at(-1);
    if (parent) parent.push(...callbacks);
    else {
      const errors: unknown[] = [];
      for (const callback of callbacks) {
        try {
          callback();
        } catch (e) {
          errors.push(e);
        }
      }
      if (errors.length) throw new AggregateError(errors, "after-commit callback failed");
    }
    return out;
  }

  afterCommit(fn: () => void): void {
    const callbacks = this.commits.at(-1);
    if (callbacks) callbacks.push(fn);
    else fn();
  }

  // runs

  putRun(run: Run): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, state, grp, created_at, doc) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, grp = excluded.grp, doc = excluded.doc`,
      )
      .run(run.id, run.state, run.spec.group ?? null, run.createdAt, JSON.stringify(run));
  }

  getRun(id: string): Run | null {
    const row = this.db.prepare("SELECT doc FROM runs WHERE id = ?").get(id) as
      | { doc: string }
      | undefined;
    return row ? Run.parse(JSON.parse(row.doc)) : null;
  }

  listRuns(filter: RunFilter = {}): Run[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.states?.length) {
      where.push(`state IN (${filter.states.map(() => "?").join(",")})`);
      args.push(...filter.states);
    }
    if (filter.group) {
      where.push("grp = ?");
      args.push(filter.group);
    }
    if (filter.folder) {
      where.push(IN_FOLDER);
      args.push(filter.folder, filter.folder, filter.folder);
    }
    if (filter.before) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      args.push(filter.before.createdAt, filter.before.createdAt, filter.before.id);
    }
    const sql = `SELECT doc FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY created_at DESC, id DESC LIMIT ${Math.max(1, filter.limit ?? 500)}`;
    const rows = this.db.prepare(sql).all(...args) as { doc: string }[];
    return rows.map((r) => Run.parse(JSON.parse(r.doc)));
  }

  /** Cleaned-up local runs whose directory size has not been measured. */
  unmeasuredRuns(): Run[] {
    const rows = this.db
      .prepare(
        `SELECT doc FROM runs WHERE json_extract(doc, '$.cleanup') = 'done'
         AND json_extract(doc, '$.sizeBytes') IS NULL
         AND COALESCE(json_extract(doc, '$.remote'), 0) = 0
         ORDER BY created_at DESC`,
      )
      .all() as { doc: string }[];
    return rows.map((r) => Run.parse(JSON.parse(r.doc)));
  }

  /** Folders in use, with what is directly in each (not their subfolders). */
  folders(): FolderStat[] {
    const runs = this.db
      .prepare(
        `SELECT ${FOLDER} AS f, COUNT(*) AS n,
           SUM(state IN ('queued','starting','running')) AS active,
           COALESCE(SUM(json_extract(doc, '$.sizeBytes')), 0) AS bytes, MAX(created_at) AS at
         FROM runs WHERE ${FOLDER} != '' GROUP BY f`,
      )
      .all() as { f: string; n: number; active: number; bytes: number; at: string }[];
    const jobs = this.db
      .prepare(
        `SELECT ${FOLDER} AS f, COUNT(*) AS n, MAX(created_at) AS at
         FROM bench_jobs WHERE ${FOLDER} != '' GROUP BY f`,
      )
      .all() as { f: string; n: number; at: string }[];
    const out = new Map<string, FolderStat>();
    const get = (f: string, at: string) => {
      const s = out.get(f) ?? { path: f, runs: 0, jobs: 0, active: 0, sizeBytes: 0, updatedAt: at };
      if (at > s.updatedAt) s.updatedAt = at;
      out.set(f, s);
      return s;
    };
    for (const r of runs)
      Object.assign(get(r.f, r.at), { runs: r.n, active: r.active, sizeBytes: r.bytes });
    for (const j of jobs) get(j.f, j.at).jobs = j.n;
    return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Bench jobs in a folder or its subfolders. */
  jobsIn(folder: string): BenchJob[] {
    const rows = this.db
      .prepare(`SELECT doc FROM bench_jobs WHERE ${IN_FOLDER} ORDER BY created_at`)
      .all(folder, folder, folder) as { doc: string }[];
    return rows.map((r) => BenchJob.parse(JSON.parse(r.doc)));
  }

  /** Queued runs, higher priority first, then in submission order. */
  queuedRuns(): Run[] {
    const rows = this.db
      .prepare(
        `SELECT doc FROM runs WHERE state = 'queued'
         ORDER BY COALESCE(json_extract(doc, '$.spec.priority'), 0) DESC, created_at, id`,
      )
      .all() as { doc: string }[];
    return rows.map((r) => Run.parse(JSON.parse(r.doc)));
  }

  /** Terminal local runs whose container has not been confirmed removed. */
  pendingCleanup(): Run[] {
    const rows = this.db
      .prepare(
        `SELECT doc FROM runs WHERE state IN ('succeeded','failed','cancelled','lost')
         AND json_extract(doc, '$.cleanup') != 'done'
         AND COALESCE(json_extract(doc, '$.remote'), 0) = 0`,
      )
      .all() as { doc: string }[];
    return rows.map((r) => Run.parse(JSON.parse(r.doc)));
  }

  // leases

  putLease(lease: Lease): void {
    this.db
      .prepare(
        `INSERT INTO leases (id, run_id, state, doc) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, doc = excluded.doc`,
      )
      .run(lease.id, lease.runId, lease.state, JSON.stringify(lease));
  }

  activeLeases(): Lease[] {
    const rows = this.db.prepare("SELECT doc FROM leases WHERE state = 'active'").all() as {
      doc: string;
    }[];
    return rows.map((r) => Lease.parse(JSON.parse(r.doc)));
  }

  // events

  addEvent(runId: string, kind: string, message: string, at = nowIso()): RunEvent {
    const r = this.db
      .prepare("INSERT INTO events (run_id, at, kind, message) VALUES (?, ?, ?, ?)")
      .run(runId, at, kind, message);
    return { seq: Number(r.lastInsertRowid), runId, at, kind, message };
  }

  events(runId: string, afterSeq = 0): RunEvent[] {
    const rows = this.db
      .prepare(
        "SELECT seq, run_id, at, kind, message FROM events WHERE run_id = ? AND seq > ? ORDER BY seq",
      )
      .all(runId, afterSeq) as {
      seq: number;
      run_id: string;
      at: string;
      kind: string;
      message: string;
    }[];
    return rows.map((r) =>
      RunEvent.parse({ seq: r.seq, runId: r.run_id, at: r.at, kind: r.kind, message: r.message }),
    );
  }

  // remote runs

  putSync(s: RemoteSync): void {
    this.db
      .prepare(
        `INSERT INTO remote_sync (run_id, node, event_seq, confirmed, cancel, done)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET node = excluded.node, event_seq = excluded.event_seq,
           confirmed = excluded.confirmed, cancel = excluded.cancel, done = excluded.done`,
      )
      .run(s.runId, s.node, s.eventSeq, s.confirmed ? 1 : 0, s.cancel ? 1 : 0, s.done ? 1 : 0);
  }

  getSync(runId: string): RemoteSync | null {
    const row = this.db.prepare("SELECT * FROM remote_sync WHERE run_id = ?").get(runId) as
      | SyncRow
      | undefined;
    return row ? syncOf(row) : null;
  }

  /** Remove runs with their events, leases and mirroring state (one transaction). */
  deleteRuns(ids: string[]): void {
    this.tx(() => {
      for (const id of ids) {
        this.db.prepare("DELETE FROM runs WHERE id = ?").run(id);
        this.db.prepare("DELETE FROM events WHERE run_id = ?").run(id);
        this.db.prepare("DELETE FROM leases WHERE run_id = ?").run(id);
        this.db.prepare("DELETE FROM remote_sync WHERE run_id = ?").run(id);
      }
    });
  }

  deleteSync(runId: string): void {
    this.db.prepare("DELETE FROM remote_sync WHERE run_id = ?").run(runId);
  }

  /** Remote runs still being mirrored. */
  openSyncs(): RemoteSync[] {
    const rows = this.db
      .prepare("SELECT * FROM remote_sync WHERE done = 0 ORDER BY run_id")
      .all() as unknown as SyncRow[];
    return rows.map(syncOf);
  }

  // benchmark jobs and trials

  putJob(job: BenchJob): void {
    this.db
      .prepare(
        `INSERT INTO bench_jobs (id, state, created_at, doc) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, doc = excluded.doc`,
      )
      .run(job.id, job.state, job.createdAt, JSON.stringify(job));
  }

  getJob(id: string): BenchJob | null {
    const row = this.db.prepare("SELECT doc FROM bench_jobs WHERE id = ?").get(id) as
      | { doc: string }
      | undefined;
    return row ? BenchJob.parse(JSON.parse(row.doc)) : null;
  }

  listJobs(limit = 200): BenchJob[] {
    const rows = this.db
      .prepare("SELECT doc FROM bench_jobs ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit) as { doc: string }[];
    return rows.map((r) => BenchJob.parse(JSON.parse(r.doc)));
  }

  jobSummaries(jobs: BenchJob[]): Map<string, MethodSummary[]> {
    if (jobs.length === 0) return new Map();
    const rows = this.db
      .prepare(
        `WITH fields AS MATERIALIZED (
           SELECT id, job_id, jsonb_extract(doc, '$.method', '$.task', '$.outcome.evaluation',
             '$.outcome.score', '$.outcome.maxScore', '$.outcome.metrics') AS data
           FROM trials WHERE job_id IN (SELECT value FROM json_each(?))
         ), selected AS MATERIALIZED (
           SELECT id, job_id, json_extract(data, '$[0]') AS method,
             json_extract(data, '$[2]') AS evaluation,
             jsonb_extract(data, '$[1]', '$[3]', '$[4]', '$[5]') AS metric_data FROM fields
         )
         SELECT job_id, method,
           COUNT(*) AS trials, COALESCE(SUM(evaluation = 'valid'), 0) AS valid,
           COALESCE(SUM(evaluation = 'invalid'), 0) AS invalid,
           COALESCE(SUM(evaluation = 'unknown'), 0) AS unknown,
           SUM(evaluation IS NULL) AS pending,
           json_group_array(metric_data ORDER BY id) FILTER (WHERE evaluation = 'valid') AS metric_data
         FROM selected GROUP BY job_id, method`,
      )
      .all(JSON.stringify(jobs.map((j) => j.id))) as unknown as {
      job_id: string;
      method: string;
      metric_data: string;
      trials: number;
      valid: number;
      invalid: number;
      unknown: number;
      pending: number;
    }[];
    const byJob = Map.groupBy(rows, (r) => r.job_id);
    return new Map(
      jobs.map((job) => {
        const byMethod = new Map((byJob.get(job.id) ?? []).map((r) => [r.method, r]));
        return [
          job.id,
          job.spec.methods.map(({ name: method }) => {
            const counts = byMethod.get(method);
            const data = JSON.parse(counts?.metric_data ?? "[]") as [
              string,
              number | null,
              number,
              Record<string, number> | null,
            ][];
            // Preserve the detail view's order and floating-point arithmetic, without trial docs.
            const valid = data.map(([task, score, maxScore, metrics]) => ({
              task,
              outcome: { score, maxScore, metrics: metrics ?? undefined },
            }));
            return {
              method,
              trials: counts?.trials ?? 0,
              valid: counts?.valid ?? 0,
              invalid: counts?.invalid ?? 0,
              unknown: counts?.unknown ?? 0,
              pending: counts?.pending ?? 0,
              metrics: Object.fromEntries(
                resolveMetrics(job.metrics).map((m) => [
                  m.name,
                  aggregate(taskMeans(valid, m.name)),
                ]),
              ),
            };
          }),
        ];
      }),
    );
  }

  hasOpenTrials(jobId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM trials WHERE job_id = ? AND state != 'done' LIMIT 1")
        .get(jobId),
    );
  }

  /** Remove a job and its trials (its runs are removed through RunService). */
  deleteJob(id: string): void {
    this.tx(() => {
      this.db
        .prepare(
          "DELETE FROM trial_runs WHERE trial_id IN (SELECT id FROM trials WHERE job_id = ?)",
        )
        .run(id);
      this.db.prepare("DELETE FROM trials WHERE job_id = ?").run(id);
      this.db.prepare("DELETE FROM bench_reports WHERE job_id = ?").run(id);
      this.db.prepare("DELETE FROM bench_jobs WHERE id = ?").run(id);
    });
  }

  /** Report revisions of a job, oldest first. Reports are immutable: only `addReport` writes. */
  reports(jobId: string): BenchReport[] {
    return (
      this.db
        .prepare("SELECT doc FROM bench_reports WHERE job_id = ? ORDER BY revision")
        .all(jobId) as { doc: string }[]
    ).map((r) => BenchReportSchema.parse(JSON.parse(r.doc)));
  }

  /** Append a revision; fails if that revision already exists (no overwrite). */
  addReport(r: BenchReport): void {
    this.db
      .prepare("INSERT INTO bench_reports (job_id, revision, doc) VALUES (?, ?, ?)")
      .run(r.jobId, r.revision, JSON.stringify(r));
  }

  /** Atomically replace a finished job's trial records and remove consumed source jobs. */
  consolidateJob(job: BenchJob, trials: Trial[], sources: string[], runs: Run[]): void {
    this.tx(() => {
      for (const id of [job.id, ...sources]) {
        this.db
          .prepare(
            "DELETE FROM trial_runs WHERE trial_id IN (SELECT id FROM trials WHERE job_id = ?)",
          )
          .run(id);
        this.db.prepare("DELETE FROM trials WHERE job_id = ?").run(id);
      }
      for (const id of sources) {
        this.db.prepare("DELETE FROM bench_reports WHERE job_id = ?").run(id);
        this.db.prepare("DELETE FROM bench_jobs WHERE id = ?").run(id);
      }
      for (const t of trials) {
        this.db
          .prepare(
            "INSERT INTO trials (id, job_id, state, solve_run, verify_run, doc) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(t.id, t.jobId, t.state, t.solveRunId, t.verifyRunId, JSON.stringify(t));
        for (const id of trialRunIds(t))
          this.db.prepare("INSERT INTO trial_runs (run_id, trial_id) VALUES (?, ?)").run(id, t.id);
      }
      for (const run of runs) this.putRun(run);
      this.putJob(job);
    });
  }

  putTrial(t: Trial): void {
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO trials (id, job_id, state, solve_run, verify_run, doc) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, solve_run = excluded.solve_run,
           verify_run = excluded.verify_run, doc = excluded.doc`,
        )
        .run(t.id, t.jobId, t.state, t.solveRunId, t.verifyRunId, JSON.stringify(t));
      const link = this.db.prepare(
        "INSERT OR IGNORE INTO trial_runs (run_id, trial_id) VALUES (?, ?)",
      );
      for (const r of trialRunIds(t)) link.run(r, t.id);
    });
  }

  getTrial(id: string): Trial | null {
    const row = this.db.prepare("SELECT doc FROM trials WHERE id = ?").get(id) as
      | { doc: string }
      | undefined;
    return row ? Trial.parse(JSON.parse(row.doc)) : null;
  }

  trials(jobId: string): Trial[] {
    const rows = this.db
      .prepare("SELECT doc FROM trials WHERE job_id = ? ORDER BY id")
      .all(jobId) as { doc: string }[];
    return rows.map((r) => Trial.parse(JSON.parse(r.doc)));
  }

  /** The trial that owns a run: its solve run, verify run or an earlier verify run. */
  trialByRun(runId: string): Trial | null {
    const row = this.db
      .prepare(
        "SELECT t.doc FROM trial_runs r JOIN trials t ON t.id = r.trial_id WHERE r.run_id = ?",
      )
      .get(runId) as { doc: string } | undefined;
    return row ? Trial.parse(JSON.parse(row.doc)) : null;
  }

  openTrials(): Trial[] {
    const rows = this.db
      .prepare("SELECT doc FROM trials WHERE state != 'done' ORDER BY id")
      .all() as {
      doc: string;
    }[];
    return rows.map((r) => Trial.parse(JSON.parse(r.doc)));
  }

  pendingTrialCleanup(): Trial[] {
    const rows = this.db
      .prepare(
        "SELECT doc FROM trials WHERE state = 'done' AND json_extract(doc, '$.outcome.cleanup') = 'pending'",
      )
      .all() as { doc: string }[];
    return rows.map((r) => Trial.parse(JSON.parse(r.doc)));
  }
}

interface SyncRow {
  run_id: string;
  node: string;
  event_seq: number;
  confirmed: number;
  cancel: number;
  done: number;
}

const syncOf = (r: SyncRow): RemoteSync => ({
  runId: r.run_id,
  node: r.node,
  eventSeq: r.event_seq,
  confirmed: r.confirmed === 1,
  cancel: r.cancel === 1,
  done: r.done === 1,
});
