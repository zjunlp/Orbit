// Benchmark jobs: each Trial (task × method × seed) is a solve Run and a separate verify Run (or the
// solve Run's after phase, for verifiers that need its container) on the same lease model as every
// other run. BenchService advances trials when their runs change, and
// recovers open trials from the store after a daemon restart.
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AuthEntry, AuthStore } from "../auth/index.ts";
import type { OrbitPaths } from "../config/paths.ts";
import {
  type AdapterTasksResponse,
  type AgentCapabilities,
  type AgentDefinition,
  type BenchCatalog,
  type BenchCompare,
  type BenchConsolidateInput,
  type BenchConsolidateResult,
  type BenchJob,
  type BenchJobDetail,
  type BenchJobList,
  BenchJobSpec,
  type BenchJobSpecInput,
  type Benchmark,
  type BenchReport,
  BenchRescore,
  type BenchRescoreInput,
  type BenchRescoreResult,
  type BenchTask,
  type BenchUsage,
  CalibrationRequest,
  type CalibrationRequestInput,
  calibrationMethods,
  calibrationReport,
  capabilityAllows,
  Folder,
  type FolderExportResult,
  type FolderMoveResult,
  isCliMethod,
  isTerminal,
  type Method,
  type Outcome,
  type ResolvedBinding,
  type Run,
  type RunDeletion,
  type RunSpecInput,
  type ScoreResult,
  type ServiceSpec,
  sampleIdentity,
  sampleLabel,
  sampleTasks,
  type Trial,
  trialRunIds,
} from "../contracts/index.ts";
import { metricValue, resolveMetrics } from "../contracts/metrics.ts";
import { type AgentRegistry, builtinRegistry } from "../harness/registry.ts";
import { newId, nowIso } from "../lib/ids.ts";
import { dirBytes } from "../records/index.ts";
import { NotFoundError, type RunService, UserError } from "../runs/service.ts";
import { type AgentFailure, loadRunAgentTranscript, runAgentFailure } from "../sessions/index.ts";
import type { Store } from "../store/index.ts";
import { gitSource } from "../workspace/snapshot.ts";
import { catalogEntry, type Listing } from "./catalog.ts";
import { classify, cleanupOf, shouldCheckAgentFailure, solveVerdict } from "./classify.ts";
import {
  benchGroup,
  consolidateOptions,
  planConsolidation,
  sameMethodSetup,
} from "./consolidate.ts";
import { compareJobs, summarize } from "./summary.ts";

export { benchGroup } from "./consolidate.ts";
export { compareJobs, summarize } from "./summary.ts";

import { DatasetRegistry } from "../workspace/datasets.ts";
import { asiMethodProblem } from "./asi.ts";
import { PolicyRegistry } from "./policies.ts";
import { AdapterClient, type TrialInput, toRunSpec } from "./protocol.ts";
import type { BenchmarkRegistry } from "./registry.ts";
import { applyOverride, loadResources, resolveResources, usageRows } from "./resources.ts";
import { checkSamplePlan, resolveBinding } from "./samples.ts";
import { buildReport, sameReport } from "./summary.ts";
import { addEfeTrajectory } from "./trajectory-artifacts.ts";

export interface BenchServiceDeps {
  store: Store;
  runs: RunService;
  registry: BenchmarkRegistry;
  paths: OrbitPaths;
  auth?: AuthStore;
  /** Agent definitions known on this node (they give the Agent argv for `agentTask` methods). */
  agents?: AgentRegistry;
  /** Command running this orbit binary; built-in adapters run as `<self> __adapter <name>`. */
  self?: string[];
  log?: (msg: string) => void;
}

/** Verification could not be set up: keep the solve's issues and add why. */
function failed(solve: Run, issues: string[], issue: string): Outcome {
  const c = classify(solve, null, null, issues);
  return {
    ...c,
    evaluation: "invalid",
    issues: [...c.issues.filter((i) => i !== "verify not run"), issue],
  };
}

/** How long a cached task listing is shown before the catalog lists the tasks again. */
const LISTING_TTL_MS = 10 * 60_000;

export class BenchService {
  readonly policies: PolicyRegistry;
  private readonly deps: BenchServiceDeps;
  /** Agent definitions; built-ins when the caller (tests, embedders) did not supply a registry. */
  private readonly agents: AgentRegistry;
  /** Trials being advanced, and those changed meanwhile (advanced once more afterwards). */
  private readonly busy = new Set<string>();
  private readonly again = new Set<string>();
  /** Task listings of registered benchmarks for the catalog, refreshed in the background. */
  private readonly listings = new Map<string, Listing>();
  private listingQueue: Promise<void> = Promise.resolve();

  constructor(deps: BenchServiceDeps) {
    this.deps = deps;
    this.policies = new PolicyRegistry(join(deps.paths.home, "policies.json"));
    this.agents = deps.agents ?? builtinRegistry();
    deps.runs.on("change", ({ run }) => this.onRun(run));
  }

  /**
   * Pick up trials left open by a previous daemon (after RunService has recovered its runs), in the
   * background: advancing them may call adapters, which must not hold up the daemon's start.
   */
  start(): void {
    for (const t of this.deps.store.pendingTrialCleanup()) {
      if (this.reconcileCleanup(t))
        this.deps.log?.(`bench trial ${t.id}: repaired outcome cleanup`);
    }
    this.advanceAll(this.deps.store.openTrials().map((t) => t.id));
    // A calibration job that ended while the daemon was down still gets its rescore step.
    for (const j of this.deps.store.listJobs(10_000))
      if (j.spec.calibration && j.state !== "running" && j.rescore?.state !== "done")
        if (!this.deps.store.hasOpenTrials(j.id)) this.afterCalibration(j.id);
  }

  /** Advance trials one after another in the background (each may run adapter processes). */
  private advanceAll(ids: string[]): void {
    void (async () => {
      for (const id of ids) await this.advance(id);
    })();
  }

  // ---- benchmarks ----

  benchmark(name: string): Benchmark {
    const b = this.deps.registry.get(name);
    if (!b) throw new NotFoundError(`benchmark not found: ${name}`);
    return b;
  }

  private adapter(b: Benchmark): AdapterClient {
    return new AdapterClient(b, this.deps.self);
  }

  /** Tasks and metrics as the adapter lists them; adapter failures are the user's to fix. */
  async infoOf(b: Benchmark): Promise<AdapterTasksResponse> {
    if (!existsSync(b.path)) throw new UserError(`benchmark path not found: ${b.path}`);
    try {
      return await this.adapter(b).tasks();
    } catch (e) {
      throw new UserError((e as Error).message);
    }
  }

  async tasks(name: string): Promise<BenchTask[]> {
    return (await this.infoOf(this.benchmark(name))).tasks;
  }

  // ---- jobs ----

  async submit(input: BenchJobSpecInput, opts: { folder?: string } = {}): Promise<BenchJob> {
    const parsed = BenchJobSpec.safeParse(input);
    if (!parsed.success) throw new UserError(parsed.error.issues.map((i) => i.message).join("; "));
    const folder = Folder.safeParse(opts.folder ?? "");
    if (!folder.success) throw new UserError(folder.error.issues[0]?.message ?? "invalid folder");
    const spec = parsed.data;
    const b = this.benchmark(spec.benchmark);
    const info = await this.infoOf(b);
    const all = info.tasks;
    const names = new Set<string>();
    const resolvedBindings: Record<string, ResolvedBinding> = {};
    for (const m of spec.methods) {
      if (names.has(m.name)) throw new UserError(`duplicate method name: ${m.name}`);
      names.add(m.name);
      if (info.capabilities && !capabilityAllows(info.capabilities.methods, m.agent))
        throw new UserError(`${b.name} does not support ${m.agent} methods`);
      const asi = b.adapter === "asi" ? asiMethodProblem(m) : null;
      if (asi) throw new UserError(`${m.name}: ${asi}`);
      this.checkMethod(m, info.capabilities?.requires ?? []);
      if (m.agent === "policy") {
        const policy = this.policies.get(m.policyRef ?? "");
        if (!policy) throw new UserError(`${m.name}: unknown policy ${m.policyRef}`);
        m.policySnapshot = structuredClone(policy);
        const endpoint = info.capabilities?.embodied;
        if (!endpoint) throw new UserError("the benchmark has no independent policy contract");
        try {
          resolvedBindings[m.name] = resolveBinding(
            endpoint.semanticProfile,
            policy.profile,
            endpoint.observationMap,
          );
        } catch (e) {
          throw new UserError(`${m.name}: ${(e as Error).message}`);
        }
      }
    }
    if (spec.tasks.length === 0)
      spec.tasks = spec.samplePlan
        ? [...new Set(spec.samplePlan.items.map((sample) => sample.taskId))]
        : all.filter((t) => t.supported).map((t) => t.id);
    for (const id of spec.tasks) {
      const t = all.find((x) => x.id === id);
      if (!t) throw new UserError(`task not found in ${b.name}: ${id}`);
      if (!t.supported) throw new UserError(`task ${id} is not supported: ${t.reason}`);
    }
    if (spec.tasks.length === 0) throw new UserError(`${b.name} has no supported tasks`);
    if (spec.samplePlan) {
      try {
        checkSamplePlan(spec.samplePlan);
      } catch (e) {
        throw new UserError((e as Error).message);
      }
      if (spec.methods.some((m) => m.agent !== "policy"))
        throw new UserError("planned C6 jobs currently require independent policy methods");
      for (const sample of spec.samplePlan.items) {
        if (sample.benchmarkProfile !== info.capabilities?.embodied?.profile)
          throw new UserError("sample evaluation profile does not match the benchmark");
        if (!spec.tasks.includes(sample.taskId))
          throw new UserError(`sample task is not selected: ${sample.taskId}`);
        const expectedAsset = all.find((task) => task.id === sample.taskId)?.tags
          .initialStateDigest;
        if (expectedAsset && expectedAsset !== sample.initialStateDigest)
          throw new UserError(`initial-state asset differs from the benchmark: ${sample.taskId}`);
      }
      if (spec.tasks.some((task) => !spec.samplePlan?.items.some((s) => s.taskId === task)))
        throw new UserError("every selected task needs at least one planned sample");
    } else if (spec.methods.some((m) => m.agent === "policy")) {
      throw new UserError(
        "policy methods require a frozen samplePlan; legacy seeds cannot identify their samples",
      );
    }
    let resources: BenchJob["resources"] = null;
    if (b.resources) {
      try {
        resources = resolveResources(
          loadResources(b.resources),
          spec.tasks,
          all.map((t) => t.id),
        );
      } catch (e) {
        throw new UserError((e as Error).message);
      }
    }
    const job: BenchJob = {
      id: newId(),
      spec,
      benchmarkSnapshot: structuredClone(b),
      ...(spec.samplePlan ? { resolvedBindings } : {}),
      ...(info.capabilities ? { capabilities: structuredClone(info.capabilities) } : {}),
      ...(info.official ? { official: structuredClone(info.official) } : {}),
      resources,
      folder: folder.data,
      metrics: resolveMetrics(info.metrics),
      source: await gitSource(b.path),
      state: "running",
      createdAt: nowIso(),
      endedAt: null,
    };
    let n = 0;
    const ids: string[] = [];
    this.deps.store.tx(() => {
      this.deps.store.putJob(job);
      const slots = spec.samplePlan
        ? spec.samplePlan.items.flatMap((sample) =>
            spec.methods.map((method) => ({
              method,
              sample: { task: sample.taskId, sampleRef: sample.sampleId },
            })),
          )
        : spec.tasks.flatMap((task) =>
            spec.methods.flatMap((method) =>
              Array.from({ length: spec.seeds ?? 1 }, (_, index) => ({
                method,
                sample: { task, seed: index + 1 },
              })),
            ),
          );
      for (const { sample, method } of slots) {
        const t: Trial = {
          ...sample,
          id: `${job.id}.${String(++n).padStart(5, "0")}`,
          jobId: job.id,
          method: method.name,
          state: "pending",
          solveRunId: null,
          verifyRunId: null,
          issues: [],
          outcome: null,
          history: [],
          createdAt: job.createdAt,
          endedAt: null,
        };
        this.deps.store.putTrial(t);
        ids.push(t.id);
      }
    });
    this.advanceAll(ids);
    return job;
  }

  /** The Agent definition a method names; `external`/`oracle`/`empty` never reach a definition. */
  private agentDef(m: Method): AgentDefinition {
    const def = this.agents.get(m.agent);
    if (!def) throw new UserError(`${m.name}: unknown Agent ${m.agent}`);
    return def;
  }

  private checkMethod(m: Method, requires: readonly (keyof AgentCapabilities)[] = []): void {
    if (m.agent === "external") return;
    if (!isCliMethod(m)) {
      if (m.auth || m.bundle || m.model)
        throw new UserError(`${m.name}: ${m.agent} takes no auth, model or bundle`);
      return;
    }
    const def = this.agents.get(m.agent);
    if (!def) throw new UserError(`${m.name}: unknown Agent ${m.agent}; see \`orbit agent ls\``);
    if (requires.includes("mcp") && def.command.mcp.kind === "none")
      throw new UserError(
        `${m.name}: this benchmark requires MCP, but ${m.agent} has no MCP wiring`,
      );
    const lacking = requires.filter((k) => !def.capabilities[k]);
    if (lacking.length)
      throw new UserError(
        `${m.name}: this benchmark needs Agent capabilities ${lacking.join(", ")}, which ${m.agent} does not declare`,
      );
    const entry = m.auth ? this.deps.auth?.get(m.auth) : null;
    if (!entry) throw new UserError(`${m.name}: auth profile not found: ${m.auth}`);
    if (!def.auth.kinds.includes(entry.profile.kind))
      throw new UserError(
        `${m.name}: ${m.agent} does not support ${entry.profile.kind} auth profiles`,
      );
    if (entry.profile.harness !== m.agent)
      throw new UserError(
        `${m.name}: auth profile ${m.auth} is for ${entry.profile.harness}, not ${m.agent}`,
      );
  }

  job(id: string): BenchJobDetail {
    const job = this.deps.store.getJob(id);
    if (!job) throw new NotFoundError(`bench job not found: ${id}`);
    const trials = this.deps.store.trials(id);
    const calibration = calibrationReport(job, trials);
    return {
      job,
      trials,
      summary: summarize(
        job.spec.methods.map((m) => m.name),
        trials,
        job.metrics,
        job.official,
      ),
      ...(calibration ? { calibration } : {}),
    };
  }

  // ---- calibration and catalog (design §9.15) ----

  /**
   * Start a calibration job: sampled (or given) tasks × the calibration methods the benchmark
   * admits × seeds. Its report is part of the job detail; the daemon rescores it once it ends.
   */
  async calibrate(input: CalibrationRequestInput): Promise<BenchJob> {
    const parsed = CalibrationRequest.safeParse(input);
    if (!parsed.success) throw new UserError(parsed.error.issues.map((i) => i.message).join("; "));
    const r = parsed.data;
    const info = await this.infoOf(this.benchmark(r.benchmark));
    this.remember(r.benchmark, info);
    const oracle = r.oracle && info.capabilities?.calibration?.oracle !== "none";
    const tasks = r.tasks.length ? r.tasks : sampleTasks(info.tasks, r.sample, r.suite, oracle);
    if (!tasks.length) throw new UserError(`${r.benchmark} has no supported tasks to calibrate`);
    const methods = calibrationMethods(info.capabilities, r.oracle);
    if (!methods.length) throw new UserError(`${r.benchmark} admits neither empty nor oracle`);
    const noOracle = info.tasks
      .filter((t) => tasks.includes(t.id) && t.tags.oracle && t.tags.oracle !== "full")
      .map((t) => t.id);
    return this.submit({
      name: `calibrate ${r.benchmark}`,
      benchmark: r.benchmark,
      tasks,
      methods: methods.map((m) => ({ name: m, agent: m as "empty" | "oracle" })),
      seeds: r.seeds,
      calibration: { noOracle, rescore: r.rescore },
      ...(r.timeoutMin ? { timeoutMin: r.timeoutMin } : {}),
    });
  }

  /** A calibration job's trials have all ended: rescore it once from saved evidence, then finish. */
  private afterCalibration(id: string): void {
    const job = this.deps.store.getJob(id);
    const c = job?.spec.calibration;
    if (!job || !c || job.rescore?.state === "done") return;
    const done = (note?: string) => {
      const fresh = this.deps.store.getJob(id) ?? job;
      fresh.rescore = { state: "done", ...(note ? { note } : {}) };
      this.deps.store.putJob(fresh);
    };
    const skip =
      job.rescore?.state === "started"
        ? (job.rescore.note ?? null)
        : !c.rescore
          ? "disabled"
          : job.state === "cancelled"
            ? "job cancelled"
            : job.capabilities?.rescore === "none"
              ? "the benchmark declares no rescore"
              : undefined;
    if (skip !== undefined) {
      done(skip ?? undefined);
      return;
    }
    job.rescore = { state: "started" };
    this.deps.store.putJob(job);
    try {
      const r = this.rescore(id);
      if (r.skipped.length) {
        const fresh = this.deps.store.getJob(id) ?? job;
        fresh.rescore = {
          state: fresh.rescore?.state ?? "started",
          note: `${r.skipped.length} trial(s) not rescored: ${r.skipped[0]?.reason}`,
        };
        this.deps.store.putJob(fresh);
      }
    } catch (e) {
      done(`rescore refused: ${(e as Error).message}`);
    }
  }

  /** Every registered benchmark with its listing, calibrations, real methods and fidelity. */
  catalog(refresh: string[] = []): BenchCatalog {
    const jobs = this.jobs(10_000).jobs;
    return {
      entries: this.deps.registry.list().map((b) => {
        this.refreshListing(b, refresh.includes(b.name));
        const own = jobs.filter((j) => j.spec.benchmark === b.name);
        const calibrations = own
          .filter((j) => j.spec.calibration)
          .slice(0, 5)
          .map((j) => calibrationReport(j, this.deps.store.trials(j.id)))
          .filter((r) => r !== null);
        return catalogEntry(b, this.listing(b.name), own, calibrations);
      }),
    };
  }

  private listing(name: string): Listing {
    return this.listings.get(name) ?? { at: null, data: null, error: null, refreshing: false };
  }

  private remember(name: string, data: AdapterTasksResponse): void {
    this.listings.set(name, { at: nowIso(), data, error: null, refreshing: false });
  }

  /** List a benchmark's tasks again in the background when the cached listing is old or forced. */
  private refreshListing(b: Benchmark, force: boolean): void {
    const l = this.listing(b.name);
    const age = l.at ? Date.now() - Date.parse(l.at) : Number.POSITIVE_INFINITY;
    if (l.refreshing || (!force && age < LISTING_TTL_MS && (l.data || l.error))) return;
    this.listings.set(b.name, { ...l, refreshing: true });
    // One listing at a time: adapters may start containers to list tasks.
    this.listingQueue = this.listingQueue.then(async () => {
      try {
        this.remember(b.name, await this.infoOf(b));
      } catch (e) {
        this.listings.set(b.name, {
          ...this.listing(b.name),
          at: nowIso(),
          error: (e as Error).message,
          refreshing: false,
        });
      }
    });
  }

  jobs(limit = 200): BenchJobList {
    const jobs = this.deps.store.listJobs(limit);
    const summaries = this.deps.store.jobSummaries(jobs);
    return {
      jobs: jobs.map((job) => ({
        ...job,
        summary: summaries.get(job.id) ?? [],
      })),
    };
  }

  compare(ids: string[]): BenchCompare {
    if (ids.length === 0) throw new UserError("no jobs to compare");
    if (new Set(ids).size !== ids.length) throw new UserError("a job is listed more than once");
    return compareJobs(ids.map((id) => this.job(id)));
  }

  /**
   * File runs and bench jobs in a folder. A job takes its runs along, and a run of a bench trial
   * moves with its whole job, so a job and its runs are always in one folder.
   */
  move(ids: string[], folder: string): FolderMoveResult {
    const jobs = new Map<string, BenchJob>();
    const runs: string[] = [];
    for (const id of new Set(ids)) {
      const job = this.deps.store.getJob(id);
      const owner = job ?? this.ownerJob(id);
      if (owner) jobs.set(owner.id, owner);
      else if (this.deps.runs.get(id)) runs.push(id);
      else throw new NotFoundError(`no run or bench job ${id}`);
    }
    for (const job of jobs.values()) {
      job.folder = folder;
      this.deps.store.putJob(job);
      runs.push(...this.deps.store.trials(job.id).flatMap(trialRunIds));
    }
    this.deps.runs.setFolder(runs, folder);
    return { runs, jobs: [...jobs.keys()] };
  }

  private ownerJob(runId: string): BenchJob | null {
    const t = this.deps.store.trialByRun(runId);
    return t ? this.deps.store.getJob(t.jobId) : null;
  }

  /**
   * Copy a folder (with subfolders) into `dest`: `runs/<id>/` with each run's files and record,
   * `jobs/<id>.json` with each job and its trials, and `index.json`. Runs whose outputs stay on
   * another node are listed in `skipped`. `dest` must not exist yet or be empty.
   */
  async exportFolder(folder: string, dest: string): Promise<FolderExportResult> {
    if (existsSync(dest) && readdirSync(dest).length > 0)
      throw new UserError(`${dest} is not empty`);
    const data = resolve(this.deps.paths.data);
    if (resolve(dest) === data || resolve(dest).startsWith(`${data}/`))
      throw new UserError("export to a directory outside Orbit's data directory");
    const runs = this.deps.runs.storeList({ folder, limit: 1_000_000 });
    const jobs = this.deps.store.jobsIn(folder);
    if (folder && runs.length === 0 && jobs.length === 0)
      throw new UserError(`folder ${folder} is empty or does not exist`);
    mkdirSync(join(dest, "runs"), { recursive: true });
    mkdirSync(join(dest, "jobs"), { recursive: true });
    const skipped: string[] = [];
    let bytes = 0;
    let copied = 0;
    for (const r of runs) {
      if (r.remote) {
        skipped.push(`${r.id}: outputs stay on ${r.node}`);
        continue;
      }
      const to = join(dest, "runs", r.id);
      try {
        await cp(this.deps.runs.dirs(r.id).root, to, {
          recursive: true,
          verbatimSymlinks: true,
          errorOnExist: true,
        });
      } catch (e) {
        skipped.push(`${r.id}: ${(e as Error).message}`);
        continue;
      }
      writeFileSync(join(to, "run.json"), `${JSON.stringify(r, null, 2)}\n`);
      bytes += (await dirBytes(to)) ?? 0;
      copied++;
    }
    for (const j of jobs)
      writeFileSync(
        join(dest, "jobs", `${j.id}.json`),
        `${JSON.stringify({ job: j, trials: this.deps.store.trials(j.id) }, null, 2)}\n`,
      );
    writeFileSync(
      join(dest, "index.json"),
      `${JSON.stringify(
        {
          folder,
          exportedAt: nowIso(),
          runs: runs.map((r) => ({
            id: r.id,
            name: r.spec.name ?? null,
            folder: r.folder,
            state: r.state,
          })),
          jobs: jobs.map((j) => ({ id: j.id, name: j.spec.name ?? null, folder: j.folder })),
          skipped,
        },
        null,
        2,
      )}\n`,
    );
    return { dest, runs: copied, jobs: jobs.length, bytes, skipped };
  }

  /** Measured solve use per task over the given jobs, with suggested resources (never applied). */
  usage(ids: string[]): BenchUsage {
    if (ids.length === 0) throw new UserError("no jobs given");
    return {
      jobs: ids,
      rows: usageRows(
        ids.map((id) => this.job(id)),
        (id) => this.deps.runs.get(id),
      ),
    };
  }

  /** Merge retries without selecting by score; failed solve replacement requires explicit opt-in. */
  async consolidate(id: string, input: BenchConsolidateInput): Promise<BenchConsolidateResult> {
    const f = consolidateOptions(id, input);
    const sources = f.sources;
    const failures = new Map<string, AgentFailure>();
    for (const jobId of [id, ...sources]) {
      const snapshot = this.job(jobId);
      if (snapshot.trials.some((t) => t.state !== "done" || this.busy.has(t.id)))
        throw new UserError(`job ${jobId} has active trials`);
      for (const t of snapshot.trials) {
        const run = t.solveRunId ? this.deps.runs.get(t.solveRunId) : null;
        if (!run) continue;
        const failure = await this.agentFailure(run);
        if (failure) failures.set(run.id, failure);
      }
    }
    // Reload after reading session files; validate ownership and terminal state before any mutation.
    const target = this.job(id);
    const donors = sources.map((source) => this.job(source));
    const all = [target, ...donors];
    const oldRuns = new Map<string, Run>();
    for (const d of all) {
      if (d.trials.some((t) => t.state !== "done" || this.busy.has(t.id)))
        throw new UserError(`job ${d.job.id} has active trials`);
      for (const t of d.trials)
        for (const rid of trialRunIds(t)) {
          const run = this.deps.runs.get(rid);
          if (!run) throw new UserError(`missing run ${rid}`);
          const blocker = this.deps.runs.deleteBlocker(run, true);
          if (blocker) throw new UserError(blocker);
          if (this.deps.store.trialByRun(rid)?.id !== t.id)
            throw new UserError(`inconsistent run ownership: ${rid}`);
          oldRuns.set(rid, run);
        }
    }
    const benchmarks = new Map<string, Benchmark>();
    const profiles = new Map<string, AuthEntry>();
    if (f.allowTransportDifferences) {
      for (const { job } of donors) {
        if (sameMethodSetup(target.job, job)) continue;
        for (const name of [target.job.spec.benchmark, job.spec.benchmark]) {
          const b = this.deps.registry.get(name);
          if (b) benchmarks.set(name, b);
        }
        for (const [i, method] of target.job.spec.methods.entries()) {
          const other = job.spec.methods[i];
          if (method.auth === other?.auth) continue;
          for (const name of [method.auth, other?.auth]) {
            const entry = name ? this.deps.auth?.get(name) : null;
            if (entry && name) profiles.set(name, entry);
          }
        }
      }
    }
    const { job, trials, moved, ...out } = planConsolidation({
      target,
      donors,
      oldRuns,
      failures,
      flags: f,
      transport: { benchmarks, profiles },
    });
    if (f.dryRun) return out;
    // No await between validation and this transaction: concurrent HTTP mutations cannot interleave.
    this.deps.store.consolidateJob(job, trials, sources, moved);
    this.writeReport(id, "consolidate");
    const deleted = await this.deps.runs.delete(out.removedRuns);
    out.leftovers = deleted.leftovers;
    for (const source of sources) {
      const path = join(this.deps.paths.bench, source);
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        out.leftovers.push(path);
      }
    }
    return out;
  }

  /**
   * Delete a finished or cancelled job: its trials, all their solve and verify runs (with their
   * directories) and its staging files. Irreversible; refused while any of its runs is not done.
   */
  async deleteJob(id: string): Promise<RunDeletion> {
    const job = this.deps.store.getJob(id);
    if (!job) throw new NotFoundError(`bench job not found: ${id}`);
    if (job.state === "running") throw new UserError(`bench job ${id} is running; cancel it first`);
    const trials = this.deps.store.trials(id);
    if (trials.some((t) => this.busy.has(t.id)))
      throw new UserError(`bench job ${id} is still being updated; try again shortly`);
    const ids = trials.flatMap(trialRunIds).filter((r) => this.deps.runs.get(r));
    const out = await this.deps.runs.delete(ids, { forJob: true });
    this.deps.store.deleteJob(id);
    rmSync(join(this.deps.paths.bench, id), { recursive: true, force: true });
    return out;
  }

  /**
   * Score finished trials again without rerunning the Agent: each keeps its solve run, gets a new
   * verify run (the adapter builds it from the saved solve output) and a new outcome; the previous
   * verify run and outcome move to `history`. Only for jobs that are no longer running.
   */
  rescore(id: string, input: BenchRescoreInput = {}): BenchRescoreResult {
    const job = this.deps.store.getJob(id);
    if (!job) throw new NotFoundError(`bench job not found: ${id}`);
    if (job.state === "running")
      throw new UserError(`bench job ${id} is running; rescore it once it has ended`);
    if (job.capabilities?.rescore === "none")
      throw new UserError(`bench job ${id} does not support rescoring`);
    const f = BenchRescore.parse(input);
    const all = this.deps.store.trials(id);
    const unknown = [
      ...f.tasks.filter((x) => !all.some((t) => t.task === x)).map((x) => `task ${x}`),
      ...f.methods.filter((x) => !all.some((t) => t.method === x)).map((x) => `method ${x}`),
      ...f.trials.filter((x) => !all.some((t) => t.id === x)).map((x) => `trial ${x}`),
    ];
    if (unknown.length) throw new UserError(`not in job ${id}: ${unknown.join(", ")}`);
    const picked = all.filter(
      (t) =>
        (!f.tasks.length || f.tasks.includes(t.task)) &&
        (!f.methods.length || f.methods.includes(t.method)) &&
        (!f.trials.length || f.trials.includes(t.id)),
    );
    const out: BenchRescoreResult = { trials: [], skipped: [] };
    for (const t of picked) {
      const why = this.rescoreBlocker(t);
      if (why) {
        out.skipped.push({ trial: t.id, reason: why });
        continue;
      }
      t.history = [
        ...t.history,
        { verifyRunId: t.verifyRunId, outcome: t.outcome as Outcome, endedAt: t.endedAt },
      ];
      t.verifyRunId = null;
      t.outcome = null;
      t.endedAt = null;
      t.state = "solving";
      this.deps.store.putTrial(t);
      out.trials.push(t.id);
    }
    if (out.trials.length === 0)
      throw new UserError(
        `nothing to rescore${out.skipped.length ? `: ${out.skipped.map((x) => `${x.trial} ${x.reason}`).join("; ")}` : ""}`,
      );
    this.advanceAll(out.trials);
    return out;
  }

  /** Why a trial cannot be scored again, or null. */
  private rescoreBlocker(t: Trial): string | null {
    if (t.state !== "done" || !t.outcome || this.busy.has(t.id)) return "is not finished";
    const solve = t.solveRunId ? this.deps.runs.get(t.solveRunId) : null;
    if (!solve) return "has no solve run";
    if (solve.remote) return `solve output stays on ${solve.node}`;
    if (!solveVerdict(solve).verify) return `solve run ${solve.state}; nothing to verify`;
    if (solve.spec.after) return "verified in the solve environment, which is gone";
    if (!existsSync(this.deps.runs.dirs(solve.id).output)) return "solve output is gone";
    return null;
  }

  async cancel(id: string): Promise<BenchJob> {
    const job = this.deps.store.getJob(id);
    if (!job) throw new NotFoundError(`bench job not found: ${id}`);
    if (job.state !== "running") return job;
    job.state = "cancelled";
    job.endedAt = nowIso();
    this.deps.store.putJob(job);
    const trials = this.deps.store.trials(id).filter((t) => t.state !== "done");
    for (const t of trials) {
      const runId =
        t.state === "solving" ? t.solveRunId : t.state === "verifying" ? t.verifyRunId : null;
      if (runId) await this.deps.runs.cancel(runId).catch(() => undefined);
    }
    this.advanceAll(trials.map((t) => t.id));
    return job;
  }

  // ---- trial state machine ----

  private onRun(run: Run): void {
    if (!("bench" in run.spec.tags) && !run.spec.group?.startsWith("bench-")) return;
    const t = this.deps.store.trialByRun(run.id);
    if (t) void this.advance(t.id);
  }

  private async advance(id: string): Promise<void> {
    if (this.busy.has(id)) {
      this.again.add(id);
      return;
    }
    this.busy.add(id);
    try {
      do {
        this.again.delete(id);
        await this.step(id);
      } while (this.again.has(id));
    } catch (e) {
      this.deps.log?.(`bench trial ${id}: ${(e as Error).message}`);
    } finally {
      this.busy.delete(id);
    }
  }

  private context(job: BenchJob, t: Trial): { b: Benchmark; trial: TrialInput } {
    const method = job.spec.methods.find((m) => m.name === t.method);
    if (!method) throw new Error(`method ${t.method} not in job ${job.id}`);
    const sample = t.sampleRef
      ? job.spec.samplePlan?.items.find((s) => s.sampleId === t.sampleRef)
      : undefined;
    const binding = job.resolvedBindings?.[t.method];
    if (t.sampleRef && (!sample || sample.taskId !== t.task || !binding))
      throw new Error("trial sample reference or binding does not match its frozen job");
    return {
      b: job.benchmarkSnapshot ?? this.benchmark(job.spec.benchmark),
      trial: {
        id: t.id,
        task: t.task,
        method,
        ...sampleIdentity(t),
        ...(t.sampleRef ? { sample, binding } : {}),
        options: job.spec.options,
        timeoutMin: job.spec.timeoutMin ?? job.resources?.[t.task]?.timeoutMin,
        resources: job.resources?.[t.task],
        staging: join(this.deps.paths.bench, job.id, t.id),
        hostNetwork: method.auth
          ? Boolean(this.deps.auth?.get(method.auth)?.profile.hostNetwork)
          : false,
      },
    };
  }

  private ref(run: Run) {
    return { run, output: this.deps.runs.dirs(run.id).output };
  }

  private async submitRun(job: BenchJob, t: Trial, phase: "solve" | "verify", spec: RunSpecInput) {
    // Read again: the job may have been moved to another folder meanwhile.
    const folder = this.deps.store.getJob(job.id)?.folder ?? job.folder;
    return this.deps.runs.submit(
      {
        ...spec,
        ...(phase === "solve" && job.spec.checkpoint ? { checkpoint: job.spec.checkpoint } : {}),
        // Scoring reads run outputs from this node's disk, so benchmark runs stay here.
        resources: { ...spec.resources, node: this.deps.runs.nodeName },
        name: `${t.task} · ${t.method}${t.sampleRef || (job.spec.seeds ?? 1) > 1 ? ` #${sampleLabel(t)}` : ""} · ${phase}`,
        group: benchGroup(job.id),
        tags: {
          ...spec.tags,
          bench: job.spec.benchmark,
          job: job.id,
          trial: t.id,
          ...(t.sampleRef ? { execution_trial: t.id } : {}),
          phase,
        },
        params: {
          task: t.task,
          method: t.method,
          ...(t.sampleRef ? { sampleRef: t.sampleRef } : { seed: String(t.seed) }),
          phase,
        },
      },
      { folder },
    );
  }

  private finish(t: Trial, outcome: Outcome): void {
    t.state = "done";
    t.outcome = outcome;
    t.endedAt = nowIso();
    this.deps.store.putTrial(t);
    const job = this.deps.store.getJob(t.jobId);
    if (job) {
      try {
        rmSync(join(this.deps.paths.bench, job.id, t.id), { recursive: true, force: true });
      } catch (e) {
        this.deps.log?.(`bench trial ${t.id}: staging cleanup: ${(e as Error).message}`);
      }
      if (!this.deps.store.hasOpenTrials(job.id)) {
        let reason: BenchReport["reason"] =
          job.state === "cancelled" ? "cancelled" : t.history.length ? "rescore" : "finished";
        if (job.state === "running") {
          job.state = "done";
          job.endedAt = nowIso();
          this.deps.store.putJob(job);
          reason = "finished";
        }
        this.writeReport(job.id, reason);
        // After this trial's advance has let go of it, so the rescore can take it too.
        if (job.spec.calibration) setImmediate(() => this.afterCalibration(job.id));
      }
    }
  }

  /**
   * Append a report revision when the job's results changed since the last one (design §9.7).
   * Earlier revisions are never rewritten. Failures only log: a report is derived evidence.
   */
  private writeReport(jobId: string, reason: BenchReport["reason"]): BenchReport | null {
    try {
      const job = this.deps.store.getJob(jobId);
      if (!job) return null;
      const last = this.deps.store.reports(jobId).at(-1);
      const next = buildReport(
        job,
        this.deps.store.trials(jobId),
        reason,
        (last?.revision ?? 0) + 1,
        nowIso(),
      );
      if (last && sameReport(last, next)) return null;
      this.deps.store.addReport(next);
      return next;
    } catch (e) {
      this.deps.log?.(`bench job ${jobId}: report: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Report revisions of a job, oldest first. A finished job from before reports existed gets one
   * (`backfill`) on first read.
   */
  reports(id: string): BenchReport[] {
    const job = this.deps.store.getJob(id);
    if (!job) throw new NotFoundError(`bench job not found: ${id}`);
    const all = this.deps.store.reports(id);
    if (all.length === 0 && job.state !== "running" && !this.deps.store.hasOpenTrials(id))
      this.writeReport(id, "backfill");
    return this.deps.store.reports(id);
  }

  /**
   * Whether the job was cancelled under this trial. A rescore runs after the job has ended, so a
   * trial being rescored is never affected by an earlier cancel.
   */
  private cancelled(jobId: string, t: Trial): boolean {
    return t.history.length === 0 && this.deps.store.getJob(jobId)?.state === "cancelled";
  }

  /** A job cancelled while a run was being submitted: cancel that run too. */
  private async cancelIfJobCancelled(jobId: string, t: Trial, runId: string): Promise<void> {
    if (this.cancelled(jobId, t) && this.deps.store.getRun(runId)?.stopRequested !== "cancel")
      await this.deps.runs.cancel(runId).catch(() => undefined);
  }

  /** Why the Agent in a solve run could not work (credentials, quota, model endpoint), or null. */
  private agentFailure(solve: Run): Promise<AgentFailure | null> {
    if (!shouldCheckAgentFailure(solve)) return Promise.resolve(null);
    const dirs = this.deps.runs.dirs(solve.id);
    const redactor = this.deps.runs.redactor(solve);
    return runAgentFailure(dirs.agent, dirs.log, (text) => redactor.apply(text)).catch(() => null);
  }

  private skipped(t: Trial, evaluation: Outcome["evaluation"], issue: string): void {
    this.finish(t, {
      execution: "skipped",
      evaluation,
      score: null,
      maxScore: 1,
      issues: [...t.issues, issue],
      cleanup: "done",
      review: null,
    });
  }

  private reconcileCleanup(t: Trial): boolean {
    if (t.state !== "done" || t.outcome?.cleanup !== "pending") return false;
    const cleanup = cleanupOf(...trialRunIds(t).map((id) => this.deps.runs.get(id)));
    if (cleanup === "pending") return false;
    t.outcome.cleanup = cleanup;
    this.deps.store.putTrial(t);
    return true;
  }

  private async step(id: string): Promise<void> {
    const t = this.deps.store.getTrial(id);
    const job = t ? this.deps.store.getJob(t.jobId) : null;
    if (!t || !job) return;
    if (t.state === "done") {
      this.reconcileCleanup(t);
      return;
    }
    if (t.state === "pending") return this.stepPending(job, t);
    const solve = t.solveRunId ? this.deps.runs.get(t.solveRunId) : null;
    if (!solve) return this.skipped(t, "unknown", "solve run missing");
    if (t.state === "solving") return this.stepSolving(job, t, solve);
    return this.stepVerifying(job, t, solve);
  }

  private async stepPending(job: BenchJob, t: Trial): Promise<void> {
    if (job.state === "cancelled") return this.skipped(t, "unknown", "job cancelled");
    let spec: RunSpecInput;
    try {
      const { b, trial } = this.context(job, t);
      const response = await this.adapter(b).solve(trial);
      const reply = { ...response, spec: structuredClone(response.spec) };
      if (trial.method.agent === "policy") {
        const definition = trial.method.policySnapshot;
        if (!definition) throw new Error("missing frozen policy definition");
        const services = (reply.spec.services ?? []) as ServiceSpec[];
        if (services.some((service) => service.name === "policy" || service.role === "policy"))
          throw new Error("the benchmark adapter may not define the independent policy service");
        const service = {
          ...structuredClone(definition.service),
          name: "policy",
          ...(definition.service.gpusOf ? {} : { role: "policy" as const }),
        };
        if (definition.weights) {
          const source = new DatasetRegistry(join(this.deps.paths.home, "datasets.json")).path(
            definition.weights.dataset,
          );
          if (!source)
            throw new Error(`policy dataset not registered: ${definition.weights.dataset}`);
          service.binds.push({ source, target: definition.weights.target, mode: "ro" });
        }
        reply.spec.services = [...services, service];
        reply.spec.dependsOn = [
          ...new Set([...((reply.spec.dependsOn ?? []) as string[]), "policy"]),
        ];
      }

      spec = applyOverride(
        toRunSpec(
          reply.spec,
          trial.method,
          b,
          "solve",
          () => this.agentDef(trial.method),
          trial.staging,
        ),
        job.resources?.[t.task],
        job.spec.timeoutMin,
      );
      t.issues = [...t.issues, ...reply.issues];
    } catch (e) {
      return this.skipped(t, "invalid", `solve spec: ${(e as Error).message}`);
    }
    try {
      const run = await this.submitRun(job, t, "solve", spec);
      t.solveRunId = run.id;
      t.state = "solving";
      this.deps.store.putTrial(t);
      await this.cancelIfJobCancelled(job.id, t, run.id);
    } catch (e) {
      return this.skipped(t, "invalid", `solve rejected: ${(e as Error).message}`);
    }
  }

  private async stepSolving(job: BenchJob, t: Trial, solve: Run): Promise<void> {
    if (!isTerminal(solve.state)) return this.cancelIfJobCancelled(job.id, t, solve.id);
    const sv = solveVerdict(solve);
    // An Agent that could not reach or use its model left nothing worth verifying; an explicit
    // rescore (history kept) verifies anyway, and an after phase has already verified.
    const agent = t.history.length === 0 ? await this.agentFailure(solve) : null;
    if (agent && !solve.spec.after)
      return this.finish(t, classify(solve, null, null, t.issues, agent));
    if (!sv.verify || this.cancelled(job.id, t)) {
      const outcome = classify(solve, null, null, t.issues);
      if (sv.verify) {
        outcome.evaluation = "unknown";
        outcome.issues.push("job cancelled before verification");
      }
      return this.finish(t, outcome);
    }
    // The verifier ran in the solve container (its after phase): score from the solve run.
    if (solve.spec.after) return this.score(job, t, solve, solve);
    let spec: RunSpecInput;
    try {
      const { b, trial } = this.context(job, t);
      const reply = await this.adapter(b).verify(trial, this.ref(solve));
      spec = toRunSpec(reply.spec, trial.method, b, "verify", () => this.agentDef(trial.method));
      // A rescore asks again; the same solve output yields the same issues.
      t.issues = [...new Set([...t.issues, ...reply.issues])];
    } catch (e) {
      return this.finish(t, failed(solve, t.issues, `verify spec: ${(e as Error).message}`));
    }
    try {
      const run = await this.submitRun(job, t, "verify", spec);
      t.verifyRunId = run.id;
      t.state = "verifying";
      this.deps.store.putTrial(t);
      await this.cancelIfJobCancelled(job.id, t, run.id);
    } catch (e) {
      return this.finish(t, failed(solve, t.issues, `verify rejected: ${(e as Error).message}`));
    }
  }

  private async stepVerifying(job: BenchJob, t: Trial, solve: Run): Promise<void> {
    // verifying
    const verify = t.verifyRunId ? this.deps.runs.get(t.verifyRunId) : null;
    if (!verify)
      return this.finish(t, classify(solve, null, null, [...t.issues, "verify run missing"]));
    if (!isTerminal(verify.state)) return this.cancelIfJobCancelled(job.id, t, verify.id);
    return this.score(job, t, solve, verify);
  }

  /** Score a trial whose verification has ended; `verify` is the solve run for an after phase. */
  private async score(job: BenchJob, t: Trial, solve: Run, verify: Run): Promise<void> {
    const inline = verify.id === solve.id;
    const ran = inline
      ? solve.after?.state === "succeeded" || solve.after?.state === "failed"
      : verify.startedAt && verify.state !== "cancelled" && verify.state !== "lost";
    let score: ScoreResult | null = null;
    if (ran) {
      try {
        const { b, trial } = this.context(job, t);
        score = await this.adapter(b).score(trial, this.ref(solve), this.ref(verify));
      } catch (e) {
        score = {
          score: null,
          maxScore: 1,
          issues: [`score: ${(e as Error).message}`],
          invalid: true,
        };
      }
    }
    if (score) {
      const dirs = this.deps.runs.dirs(solve.id);
      const transcript = await loadRunAgentTranscript(dirs.agent).catch(() => null);
      const messages = transcript?.messages ?? [];
      const mcpTools = [
        ...new Set(
          messages
            .filter(
              (message) => message.kind === "tool_call" && /^mcp[_.]/.test(message.name ?? ""),
            )
            .map((message) => message.name as string),
        ),
      ];
      if (mcpTools.length) {
        score.review ??= { files: [], items: [], details: {} };
        score.review.details = { ...score.review.details, mcpToolsUsed: mcpTools.join(", ") };
      }
      if (this.context(job, t).b.adapter === "harbor" && t.task.startsWith("metaworldplus-"))
        await addEfeTrajectory(dirs.output, solve, score, messages, t.task);
    }
    const agent = await this.agentFailure(solve);
    const outcome = classify(solve, verify, score, t.issues, agent);
    this.recordMetrics(job, verify, outcome);
    this.finish(t, outcome);
  }

  /**
   * The trial's metric values as one line of the verify run's metrics (`bench/<name>`), so the run
   * page and run comparison show them like any other run's metrics.
   */
  private recordMetrics(job: BenchJob, verify: Run, o: Outcome): void {
    const line: Record<string, number> = {};
    for (const m of resolveMetrics(job.metrics)) {
      const v = metricValue(o, m.name);
      if (v !== null) line[`bench/${m.name}`] = v;
    }
    if (Object.keys(line).length === 0) return;
    try {
      appendFileSync(this.deps.runs.dirs(verify.id).metrics, `${JSON.stringify(line)}\n`);
    } catch (e) {
      this.deps.log?.(`bench trial metrics of ${verify.id}: ${(e as Error).message}`);
    }
  }
}
