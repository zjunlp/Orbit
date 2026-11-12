// Benchmark jobs: each Trial (task × method × seed) is a solve Run and a separate verify Run (or the
// solve Run's after phase, for verifiers that need its container) on the same lease model as every
// other run. BenchService owns job-level operations; the TrialMachine (trials.ts) advances trials
// when their runs change and recovers open trials from the store after a daemon restart.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AuthEntry, AuthStore } from "../auth/index.ts";
import type { OrbitPaths } from "../config/paths.ts";
import {
  type AdapterTasksResponse,
  type AgentCapabilities,
  type AgentCatalog,
  type AgentDefinition,
  type BenchCatalog,
  type BenchCompare,
  type BenchCompatibility,
  type BenchConsolidateInput,
  type BenchConsolidateResult,
  type BenchJob,
  type BenchJobDetail,
  type BenchJobList,
  BenchJobSpec,
  type BenchJobSpecInput,
  BenchLabels,
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
  capabilityAllows,
  Folder,
  type FolderExportResult,
  type FolderMoveResult,
  isAgentMethod,
  isCliMethod,
  type Method,
  type MethodList,
  type MethodRevision,
  type Outcome,
  type ResolvedBinding,
  type Run,
  type RunDeletion,
  sampleTasks,
  type Trial,
  trialRunIds,
} from "../contracts/index.ts";
import { resolveMetrics } from "../contracts/metrics.ts";
import { type AgentRegistry, builtinRegistry } from "../harness/registry.ts";
import { newId, nowIso } from "../lib/ids.ts";
import { dirBytes } from "../records/index.ts";
import { AUTH_TEST_GROUP, NotFoundError, type RunService, UserError } from "../runs/service.ts";
import type { AgentFailure } from "../sessions/index.ts";
import type { Store } from "../store/index.ts";
import { gitSource } from "../workspace/snapshot.ts";
import { supportedBenchmarks } from "./benchmarks/index.ts";
import { catalogEntry, type Listing } from "./catalog.ts";
import { solveVerdict } from "./classify.ts";
import { consolidateOptions, planConsolidation, sameMethodSetup } from "./consolidate.ts";
import {
  agentBlocker,
  agentCatalog,
  authTests,
  compatibility,
  jobRevision,
  methodLines,
} from "./hub.ts";
import { bundleDigest, methodBasis, revisionOf } from "./revision.ts";
import { compareJobs, summarize } from "./summary.ts";

export { benchGroup } from "./consolidate.ts";
export { compareJobs, summarize } from "./summary.ts";

import { assignSolveBatches } from "./batches.ts";
import { CalibrationLifecycle } from "./calibration.ts";
import { PolicyRegistry } from "./policies.ts";
import { AdapterClient } from "./protocol.ts";
import type { BenchmarkRegistry } from "./registry.ts";
import { loadResources, resolveResources, usageRows } from "./resources.ts";
import { resolveBinding } from "./samples.ts";
import {
  checkPlanAgainstBenchmark,
  checkTasksExist,
  resolveTaskSelection,
  trialSlots,
} from "./submit-validation.ts";
import { buildReport, sameReport } from "./summary.ts";
import { TrialMachine } from "./trials.ts";

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

/** How long a cached task listing is shown before the catalog lists the tasks again. */
const LISTING_TTL_MS = 10 * 60_000;

export class BenchService {
  readonly policies: PolicyRegistry;
  private readonly deps: BenchServiceDeps;
  /** Agent definitions; built-ins when the caller (tests, embedders) did not supply a registry. */
  private readonly agents: AgentRegistry;
  private readonly calibrations: CalibrationLifecycle;
  private readonly trials: TrialMachine;
  private stopped = false;
  /** Task listings of registered benchmarks for the catalog, refreshed in the background. */
  private readonly listings = new Map<string, Listing>();
  private listingQueue: Promise<void> = Promise.resolve();

  constructor(deps: BenchServiceDeps) {
    this.deps = deps;
    this.policies = new PolicyRegistry(join(deps.paths.home, "policies.json"));
    this.agents = deps.agents ?? builtinRegistry();
    this.calibrations = new CalibrationLifecycle({
      store: deps.store,
      runs: deps.runs,
      log: deps.log,
      stopped: () => this.stopped,
      cancel: (id) => this.cancel(id),
      rescore: (id, input) => this.rescore(id, input),
    });
    this.trials = new TrialMachine({
      store: deps.store,
      runs: deps.runs,
      paths: deps.paths,
      auth: deps.auth,
      log: deps.log,
      calibrations: this.calibrations,
      stopped: () => this.stopped,
      benchmark: (name) => this.benchmark(name),
      adapter: (b) => this.adapter(b),
      agentDef: (m) => this.agentDef(m),
      report: (jobId, reason) => {
        this.writeReport(jobId, reason);
      },
    });
    deps.runs.on("change", ({ run }) => this.trials.onRun(run));
  }

  /**
   * Pick up trials left open by a previous daemon (after RunService has recovered its runs), in the
   * background: advancing them may call adapters, which must not hold up the daemon's start.
   */
  start(): void {
    this.stopped = false;
    for (const job of this.deps.store.listJobs(10_000)) this.calibrations.arm(job);
    for (const t of this.deps.store.pendingTrialCleanup()) {
      if (this.trials.reconcileCleanup(t))
        this.deps.log?.(`bench trial ${t.id}: repaired outcome cleanup`);
    }
    this.trials.advanceAll(this.deps.store.openTrials().map((t) => t.id));
    // A calibration job that ended while the daemon was down still gets its rescore step.
    for (const j of this.deps.store.listJobs(10_000))
      if (j.spec.calibration && j.state !== "running" && j.rescore?.state !== "done")
        if (!this.deps.store.hasOpenTrials(j.id)) this.calibrations.afterTrials(j.id);
  }

  stop(): void {
    this.stopped = true;
    this.calibrations.stop();
  }

  /** Restore cancellation and budget stop intent before RunService schedules recovered work. */
  async enforceCalibrationBudgets(): Promise<void> {
    this.trials.captureLiveSolves();
    for (const stored of this.deps.store.listJobs(10_000)) {
      if (stored.state === "cancelled" && this.trials.hasLiveSolves(stored.id))
        await this.trials.stopRuns(stored, this.deps.store.trials(stored.id));
      await this.calibrations.expireIfDue(stored);
    }
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
    if (
      spec.batchSize &&
      (!info.capabilities?.embodied?.batch ||
        spec.batchSize > info.capabilities.embodied.batch.maxEpisodes)
    )
      throw new UserError("batchSize exceeds the benchmark's declared fixed-batch support");
    const names = new Set<string>();
    const resolvedBindings: Record<string, ResolvedBinding> = {};
    for (const m of spec.methods) {
      if (names.has(m.name)) throw new UserError(`duplicate method name: ${m.name}`);
      names.add(m.name);
      if (info.capabilities && !capabilityAllows(info.capabilities.methods, m.agent))
        throw new UserError(`${b.name} does not support ${m.agent} methods`);
      this.checkMethod(m, info.capabilities?.requires ?? []);
      if (m.agent === "policy") {
        const policy = this.policies.get(m.policyRef ?? "");
        if (!policy) throw new UserError(`${m.name}: unknown policy ${m.policyRef}`);
        if (spec.calibration?.mode === "policy" && policy.kind !== "model")
          throw new UserError(
            "policy integration checks require a real model registration, not a calibration fixture",
          );
        m.policySnapshot = structuredClone(policy);
        const endpoint = info.capabilities?.embodied;
        if (!endpoint) throw new UserError("the benchmark has no independent policy contract");
        // Legacy OpenPI registrations use the native runner's five-step default.
        const policyReplanSteps = policy.replanSteps ?? 5;
        if (endpoint.replanSteps !== undefined && endpoint.replanSteps !== policyReplanSteps)
          throw new UserError(
            `${m.name}: policy replanSteps ${policyReplanSteps} differs from benchmark replanSteps ${endpoint.replanSteps}`,
          );
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
    resolveTaskSelection(spec, all);
    checkTasksExist(spec, all, b.name);
    checkPlanAgainstBenchmark(spec, all, info.capabilities);
    this.checkLineage(spec);
    const revisions = await this.revisions(spec.methods);
    for (const [name, lineage] of Object.entries(spec.lineage))
      if (lineage.parent && lineage.parent === revisions[name]?.revision)
        throw new UserError(
          `${name}: parent revision matches this method; change the method or remove the parent to rerun it`,
        );
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
      revisions,
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
    const created: Trial[] = [];
    this.deps.store.tx(() => {
      this.deps.store.putJob(job);
      const slots = trialSlots(spec);
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
        created.push(t);
      }
      if (spec.batchSize) {
        // Plan order, not ID order: zero-padded IDs stop sorting numerically past 99,999 trials.
        assignSolveBatches(job, created);
        for (const trial of created) this.deps.store.putTrial(trial);
      }
    });
    this.calibrations.arm(job);
    this.trials.advanceAll(ids);
    return job;
  }

  /** Each method's content revision on this node at submission (design §9.16). */
  private async revisions(methods: Method[]): Promise<Record<string, MethodRevision>> {
    const out: Record<string, MethodRevision> = {};
    for (const m of methods) {
      if (!isAgentMethod(m)) continue;
      let cliVersion: string | null = null;
      if (isCliMethod(m)) {
        const def = this.agents.get(m.agent);
        cliVersion = def ? ((await this.agents.info(def)).version ?? null) : null;
      }
      let digest: string | null = null;
      if (m.bundle)
        try {
          digest = bundleDigest(m.bundle);
        } catch (e) {
          throw new UserError(`${m.name}: method bundle: ${(e as Error).message}`);
        }
      const profile = m.auth ? this.deps.auth?.get(m.auth)?.profile : null;
      const authKind = profile?.kind ?? null;
      const model = m.model ?? profile?.model;
      // A policy is identified by its frozen snapshot; CLI Agents by version, model and auth.
      const approximate =
        m.agent === "policy"
          ? !m.policySnapshot
          : m.agent === "external" || !cliVersion || cliVersion === "unknown" || !model;
      out[m.name] = revisionOf(
        methodBasis({ ...m, model }, { authKind, cliVersion, bundleDigest: digest }),
        approximate,
      );
    }
    return out;
  }

  /** Lineage names methods of the job, a known parent revision and existing trials. */
  private checkLineage(spec: BenchJobSpec): void {
    const names = new Set(spec.methods.map((m) => m.name));
    const known = (rev: string) =>
      this.deps.store
        .listJobs(10_000)
        .some((j) => j.spec.methods.some((m) => jobRevision(j, m.name)?.revision === rev));
    for (const [name, l] of Object.entries(spec.lineage)) {
      if (!names.has(name)) throw new UserError(`lineage names no method of this job: ${name}`);
      if (l.parent && !known(l.parent))
        throw new UserError(`${name}: parent revision ${l.parent} is not in any job`);
      for (const t of l.informedBy)
        if (!this.deps.store.getTrial(t)) throw new UserError(`${name}: trial not found: ${t}`);
    }
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
    // The same check the compatibility matrix shows (bench/hub.ts).
    const why = agentBlocker(def, undefined, requires);
    if (why) throw new UserError(`${m.name}: ${why}`);
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
    const calibration = this.calibrations.report(job, trials);
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
    if (!parsed.success) {
      const policy = input && typeof input === "object" && "policyRef" in input;
      const issues = parsed.error.issues.flatMap((issue) =>
        issue.code === "invalid_union" ? (issue.errors.at(policy ? -1 : 0) ?? [issue]) : [issue],
      );
      throw new UserError(issues.map((issue) => issue.message).join("; "));
    }
    const r = parsed.data;
    if ("policyRef" in r)
      return this.submit({
        name: `policy check ${r.benchmark} / ${r.policyRef}`,
        benchmark: r.benchmark,
        methods: [{ name: "policy", agent: "policy", policyRef: r.policyRef }],
        samplePlan: r.samplePlan,
        batchSize: r.samplePlan.items.length,
        calibration: { mode: "policy", budgetMin: r.budgetMin, rescore: r.rescore },
        timeoutMin: Math.min(r.timeoutMin ?? r.budgetMin, r.budgetMin),
      });
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

  /** Product support plus local registrations and their separate execution evidence. */
  catalog(refresh: string[] = []): BenchCatalog {
    const jobs = this.jobs(10_000).jobs;
    const entries = this.deps.registry.list().map((b) => {
      this.refreshListing(b, refresh.includes(b.name));
      const own = jobs.filter((j) => j.spec.benchmark === b.name);
      const selected = [
        ...own
          .filter((j) => j.spec.calibration && j.spec.calibration.mode !== "policy")
          .slice(0, 5),
        ...own.filter((j) => j.spec.calibration?.mode === "policy").slice(0, 5),
      ];
      const calibrations = selected
        .map((j) => this.calibrations.report(j, this.deps.store.trials(j.id)))
        .filter((r) => r !== null);
      return catalogEntry(b, this.listing(b.name), own, calibrations);
    });
    return { entries, supported: supportedBenchmarks(entries) };
  }

  /** Every Agent with its wiring, profiles, evidence and use (design §9.16). */
  async agentCatalog(): Promise<AgentCatalog> {
    const infos = await Promise.all(this.agents.list().map((d) => this.agents.info(d)));
    const runs = this.deps.store.listRuns({ group: AUTH_TEST_GROUP, limit: 500 });
    const passed = (r: Run) => {
      if (r.state !== "succeeded") return false;
      try {
        return readFileSync(this.deps.runs.dirs(r.id).log, "utf8").includes("ORBIT_AUTH_OK");
      } catch {
        return false;
      }
    };
    return agentCatalog(
      infos,
      this.jobs(10_000).jobs,
      this.deps.auth?.list() ?? [],
      authTests(runs, passed),
      (job, agent) => {
        const j = this.deps.store.getJob(job);
        const names = new Set(j?.spec.methods.filter((m) => m.agent === agent).map((m) => m.name));
        return (
          this.deps.store
            .trials(job)
            .filter((t) => names.has(t.method) && t.outcome?.evaluation === "valid")
            .sort((a, b) => ((a.endedAt ?? "") < (b.endedAt ?? "") ? 1 : -1))[0] ?? null
        );
      },
    );
  }

  /** Which CLI Agent can take which registered benchmark, by the submission checks. */
  compatibility(): BenchCompatibility {
    return compatibility(
      this.agents.list(),
      this.catalog().entries,
      this.jobs(10_000).jobs,
      this.deps.auth?.list() ?? [],
    );
  }

  /** Method lines with revisions and results compared with the previous revision. */
  methods(metric?: string): MethodList {
    return {
      methods: methodLines(
        this.jobs(10_000).jobs,
        (id) => this.deps.store.trials(id),
        (id) => this.deps.store.reports(id),
        metric,
      ),
    };
  }

  /** Set discovery labels and taxonomy defaults without changing execution. */
  label(name: string, labels: BenchLabels): Benchmark {
    const b = this.benchmark(name);
    const next = { ...b, labels: BenchLabels.parse(labels) };
    return this.deps.registry.put(next);
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
    const t = this.deps.store.trialsByRun(runId)[0];
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
      if (snapshot.trials.some((t) => t.state !== "done" || this.trials.isBusy(t.id)))
        throw new UserError(`job ${jobId} has active trials`);
      for (const t of snapshot.trials) {
        const run = t.solveRunId ? this.deps.runs.get(t.solveRunId) : null;
        if (!run) continue;
        const failure = await this.trials.agentFailure(run);
        if (failure) failures.set(run.id, failure);
      }
    }
    // Reload after reading session files; validate ownership and terminal state before any mutation.
    const target = this.job(id);
    const donors = sources.map((source) => this.job(source));
    const all = [target, ...donors];
    const oldRuns = new Map<string, Run>();
    for (const d of all) {
      if (d.trials.some((t) => t.state !== "done" || this.trials.isBusy(t.id)))
        throw new UserError(`job ${d.job.id} has active trials`);
      for (const t of d.trials)
        for (const rid of trialRunIds(t)) {
          const run = this.deps.runs.get(rid);
          if (!run) throw new UserError(`missing run ${rid}`);
          const blocker = this.deps.runs.deleteBlocker(run, true);
          if (blocker) throw new UserError(blocker);
          if (!this.deps.store.trialsByRun(rid).some((owner) => owner.id === t.id))
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
    if (trials.some((t) => this.trials.isBusy(t.id)))
      throw new UserError(`bench job ${id} is still being updated; try again shortly`);
    const ids = trials.flatMap(trialRunIds).filter((r) => this.deps.runs.get(r));
    for (const runId of new Set(ids))
      if (this.deps.store.trialsByRun(runId).some((owner) => owner.jobId !== id))
        throw new UserError(`shared run ${runId} is still referenced by another job`);
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
    this.calibrations.settle(job);
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
    this.trials.advanceAll(out.trials);
    return out;
  }

  /** Why a trial cannot be scored again, or null. */
  private rescoreBlocker(t: Trial): string | null {
    if (t.state !== "done" || !t.outcome || this.trials.isBusy(t.id)) return "is not finished";
    const solve = t.solveRunId ? this.deps.runs.get(t.solveRunId) : null;
    if (!solve) return "has no solve run";
    if (solve.remote) return `solve output stays on ${solve.node}`;
    if (!solveVerdict(solve).verify && !this.trials.hasEpisodeEvidence(t, solve))
      return `solve run ${solve.state}; nothing to verify`;
    if (solve.spec.after) return "verified in the solve environment, which is gone";
    if (!existsSync(this.deps.runs.dirs(solve.id).output)) return "solve output is gone";
    return null;
  }

  async cancel(id: string): Promise<BenchJob> {
    const job = this.deps.store.getJob(id);
    if (!job) throw new NotFoundError(`bench job not found: ${id}`);
    const policyCheck = job.spec.calibration?.mode === "policy";
    if (job.state !== "running" && !(policyCheck && !job.calibrationExecutionEndedAt)) return job;
    job.state = "cancelled";
    // A policy check ends only once its Runs are cleaned up (CalibrationLifecycle.settle).
    if (!policyCheck) job.endedAt = nowIso();
    this.deps.store.putJob(job);
    if (policyCheck) this.calibrations.disarm(id);
    const all = this.deps.store.trials(id);
    const trials = all.filter((t) => t.state !== "done");
    await this.trials.stopRuns(job, all);
    this.trials.advanceAll(trials.map((t) => t.id));
    if (policyCheck && !trials.length) this.calibrations.afterTrials(id);
    return job;
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
}
