// The trial state machine (design §7): each Trial goes pending → solving → verifying → done, driven
// by changes of its Runs. Job-level operations (submit, cancel, rescore, consolidate) live in
// BenchService and reach trials only through the public methods here.
import { appendFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AuthStore } from "../auth/index.ts";
import type { OrbitPaths } from "../config/paths.ts";
import {
  type AdapterSolveBatch,
  type AgentDefinition,
  type BenchJob,
  type Benchmark,
  type BenchReport,
  isTerminal,
  type Method,
  type Outcome,
  type Run,
  type RunSpecInput,
  RunState,
  type ScoreResult,
  type ServiceSpec,
  sampleIdentity,
  sampleLabel,
  type Trial,
  trialRunIds,
} from "../contracts/index.ts";
import { metricValue, resolveMetrics } from "../contracts/metrics.ts";
import { nowIso } from "../lib/ids.ts";
import { type RunService, UserError } from "../runs/service.ts";
import { type AgentFailure, loadRunAgentTranscript, runAgentFailure } from "../sessions/index.ts";
import type { Store } from "../store/index.ts";
import { DatasetRegistry } from "../workspace/datasets.ts";
import { type CalibrationLifecycle, ownedRuns, policyDeadline } from "./calibration.ts";
import { classify, cleanupOf, shouldCheckAgentFailure, solveVerdict } from "./classify.ts";
import { benchGroup } from "./consolidate.ts";
import { type AdapterClient, AdapterError, type TrialInput, toRunSpec } from "./protocol.ts";
import { applyOverride } from "./resources.ts";

export interface TrialMachineDeps {
  store: Store;
  runs: RunService;
  paths: OrbitPaths;
  auth?: AuthStore;
  log?: (msg: string) => void;
  calibrations: CalibrationLifecycle;
  /** Whether the bench service has stopped; then Run changes are ignored. */
  stopped: () => boolean;
  benchmark: (name: string) => Benchmark;
  adapter: (b: Benchmark) => AdapterClient;
  agentDef: (m: Method) => AgentDefinition;
  /** Append a report revision once a job's last trial has ended. */
  report: (jobId: string, reason: BenchReport["reason"]) => void;
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

export class TrialMachine {
  private readonly deps: TrialMachineDeps;
  /** Trials being advanced, and those changed meanwhile (advanced once more afterwards). */
  private readonly busy = new Set<string>();
  private readonly again = new Set<string>();
  private readonly batchBusy = new Set<string>();
  /** Solves still live from the previous daemon, by job: the only Runs a restart may need to claim. */
  private readonly liveAtStart = new Map<string, Run[]>();

  constructor(deps: TrialMachineDeps) {
    this.deps = deps;
  }

  /** Whether a trial is being advanced right now (job operations wait for it). */
  isBusy(id: string): boolean {
    return this.busy.has(id);
  }

  /** Remember solves live at daemon start, before RunService schedules recovered work. */
  captureLiveSolves(): void {
    this.liveAtStart.clear();
    const live = RunState.options.filter((state) => !isTerminal(state));
    for (const run of this.deps.runs.storeList({ states: live, limit: 100_000 })) {
      const job = run.spec.tags.job;
      if (job && run.spec.tags.phase === "solve" && run.spec.group === benchGroup(job))
        this.liveAtStart.set(job, [...(this.liveAtStart.get(job) ?? []), run]);
    }
  }

  hasLiveSolves(jobId: string): boolean {
    return this.liveAtStart.has(jobId);
  }

  /** Advance trials one after another in the background (each may run adapter processes). */
  advanceAll(ids: string[]): void {
    void (async () => {
      for (const id of ids) await this.advance(id);
    })();
  }

  onRun(run: Run): void {
    if (this.deps.stopped()) return;
    if (!("bench" in run.spec.tags) && !run.spec.group?.startsWith("bench-")) return;
    for (const t of this.deps.store.trialsByRun(run.id)) void this.advance(t.id);
    const job = this.deps.store.getJob(run.spec.tags.job ?? "");
    if (job?.spec.calibration?.mode === "policy")
      setImmediate(() => {
        if (!this.deps.stopped() && !this.deps.store.hasOpenTrials(job.id))
          this.deps.calibrations.afterTrials(job.id);
      });
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
      b: job.benchmarkSnapshot ?? this.deps.benchmark(job.spec.benchmark),
      trial: {
        id: t.id,
        task: t.task,
        method,
        ...sampleIdentity(t),
        ...(t.sampleRef ? { sample, binding } : {}),
        ...(t.batch ? { batch: t.batch } : {}),
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
    const fresh = this.deps.store.getJob(job.id) ?? job;
    const deadline = policyDeadline(fresh);
    if (
      fresh.spec.calibration?.mode === "policy" &&
      (this.cancelled(job.id, t) || (deadline !== null && Date.now() >= deadline))
    ) {
      if (deadline !== null && Date.now() >= deadline) await this.deps.calibrations.expire(job.id);
      throw new UserError("policy integration check stopped before Run submission");
    }
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
          ...(t.batch && phase === "solve"
            ? {
                execution_batch: t.batch.plan.id,
                batch_attempt: t.batch.plan.attemptId,
                batch_size: String(t.batch.plan.members.length),
              }
            : {}),
          phase,
        },
        params: {
          task: t.task,
          method: t.method,
          ...(t.sampleRef ? { sampleRef: t.sampleRef } : { seed: String(t.seed) }),
          phase,
          ...(t.batch && phase === "solve" ? { batchDigest: t.batch.plan.digest } : {}),
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
        this.deps.report(job.id, reason);
        // After this trial's advance has let go of it, so the rescore can take it too.
        if (job.spec.calibration) setImmediate(() => this.deps.calibrations.afterTrials(job.id));
      }
    }
  }

  /**
   * Whether the job was cancelled under this trial. A rescore runs after the job has ended, so a
   * trial being rescored is never affected by an earlier cancel.
   */
  private cancelled(jobId: string, t: Trial): boolean {
    const job = this.deps.store.getJob(jobId);
    return (
      job?.state === "cancelled" &&
      (t.history.length === 0 ||
        (job.spec.calibration?.mode === "policy" && !job.calibrationExecutionEndedAt))
    );
  }

  /**
   * Runs a cancelled job must stop: policy checks stop everything they own; ordinary jobs stop
   * their active solve/verify Runs and solves submitted but not yet linked to a Trial. Completed
   * ordinary batch evidence is still verified after cancellation.
   */
  private stopRunIds(job: BenchJob, all: Trial[]): string[] {
    const owned = ownedRuns(this.deps.runs, job, all);
    const live = (run: Run | null | undefined): run is Run =>
      Boolean(run && !isTerminal(run.state) && run.stopRequested !== "cancel");
    if (job.spec.calibration?.mode === "policy")
      return [...owned.values()].filter(live).map((run) => run.id);
    const linked = new Set(all.flatMap(trialRunIds));
    const active = all
      .filter((t) => t.state !== "done" && !(t.batch && t.state === "verifying"))
      .map((t) =>
        t.state === "solving" ? t.solveRunId : t.state === "verifying" ? t.verifyRunId : null,
      )
      .filter((id): id is string => id !== null);
    const unlinked = [...owned.values()]
      .filter((run) => live(run) && !linked.has(run.id) && run.spec.tags.phase === "solve")
      .map((run) => (run as Run).id);
    return [...new Set([...active, ...unlinked])];
  }

  async stopRuns(job: BenchJob, all: Trial[]): Promise<void> {
    for (const runId of this.stopRunIds(job, all))
      await this.deps.runs.cancel(runId).catch(() => undefined);
  }

  /**
   * A solve Run that was live at startup, submitted for this pending Trial (or its batch) before
   * the previous daemon wrote the linkage. Read from the startup snapshot, not a scan per step.
   */
  private claimedSolve(job: BenchJob, t: Trial): Run | null {
    const own = new Set(trialRunIds(t));
    const run = (this.liveAtStart.get(job.id) ?? []).find(
      (r) =>
        !own.has(r.id) &&
        (t.batch
          ? r.spec.tags.execution_batch === t.batch.plan.id &&
            r.spec.params.batchDigest === t.batch.plan.digest
          : r.spec.tags.trial === t.id),
    );
    return run ? (this.deps.runs.get(run.id) ?? run) : null;
  }

  /** A job cancelled while a run was being submitted: cancel that run too. */
  private async cancelIfJobCancelled(jobId: string, t: Trial, runId: string): Promise<void> {
    if (
      t.batch &&
      runId === t.verifyRunId &&
      this.deps.store.getJob(jobId)?.spec.calibration?.mode !== "policy"
    )
      return;
    const run = this.deps.store.getRun(runId);
    if (this.cancelled(jobId, t) && run && !isTerminal(run.state) && run.stopRequested !== "cancel")
      await this.deps.runs.cancel(runId).catch(() => undefined);
  }

  /** Why the Agent in a solve run could not work (credentials, quota, model endpoint), or null. */
  agentFailure(solve: Run): Promise<AgentFailure | null> {
    if (!shouldCheckAgentFailure(solve)) return Promise.resolve(null);
    const dirs = this.deps.runs.dirs(solve.id);
    const redactor = this.deps.runs.redactor(solve);
    return runAgentFailure(dirs.agent, dirs.log, (text) => redactor.apply(text)).catch(() => null);
  }

  private skipped(t: Trial, evaluation: Outcome["evaluation"], issue: string, run?: Run): void {
    this.finish(t, {
      execution: "skipped",
      evaluation,
      score: null,
      maxScore: 1,
      issues: [...t.issues, issue],
      cleanup: run ? cleanupOf(run) : "done",
      review: null,
    });
  }

  reconcileCleanup(t: Trial): boolean {
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
    if (job.state === "cancelled") {
      const claimed = this.claimedSolve(job, t);
      if (!claimed) return this.skipped(t, "unknown", "job cancelled");
      if (!isTerminal(claimed.state) && claimed.stopRequested !== "cancel")
        await this.deps.runs.cancel(claimed.id).catch(() => undefined);
      t.solveRunId = claimed.id;
      return this.skipped(t, "unknown", "job cancelled", this.deps.runs.get(claimed.id) ?? claimed);
    }
    if (t.batch) return this.stepBatchPending(job, t);
    const claimed = this.claimedSolve(job, t);
    if (claimed) {
      // Submitted before a restart, linkage not yet written: adopt it instead of solving twice.
      t.solveRunId = claimed.id;
      t.state = "solving";
      this.deps.store.putTrial(t);
      this.again.add(t.id);
      return;
    }
    try {
      const { spec, issues } = await this.solveSpec(job, t);
      t.issues.push(...issues);
      const run = await this.submitRun(job, t, "solve", spec);
      t.solveRunId = run.id;
      t.state = "solving";
      this.deps.store.putTrial(t);
      await this.cancelIfJobCancelled(job.id, t, run.id);
    } catch (e) {
      return this.skipped(t, "invalid", `solve rejected: ${(e as Error).message}`);
    }
  }

  private async solveSpec(job: BenchJob, t: Trial, batch?: AdapterSolveBatch) {
    const { b, trial } = this.context(job, t);
    const response = await this.deps.adapter(b).solve(trial, batch);
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

    const spec = applyOverride(
      toRunSpec(
        reply.spec,
        trial.method,
        b,
        "solve",
        () => this.deps.agentDef(trial.method),
        trial.staging,
      ),
      batch && job.resources?.[t.task]?.timeoutMin
        ? {
            ...job.resources[t.task],
            timeoutMin: (job.resources[t.task]?.timeoutMin ?? 0) * batch.trials.length,
          }
        : job.resources?.[t.task],
      job.spec.timeoutMin === undefined
        ? undefined
        : job.spec.timeoutMin * (batch?.trials.length ?? 1),
    );
    if (batch && spec.after) throw new Error("shared solves require independent verification");
    return { spec, issues: reply.issues };
  }

  private async stepBatchPending(job: BenchJob, t: Trial): Promise<void> {
    const plan = t.batch?.plan;
    if (!plan || this.batchBusy.has(plan.id)) return;
    this.batchBusy.add(plan.id);
    try {
      const members = plan.members.map((member) => this.deps.store.getTrial(member.trialId));
      if (members.some((member) => !member || member.batch?.plan.digest !== plan.digest))
        throw new Error("fixed batch membership differs from its frozen plan");
      const trials = members as Trial[];
      const existing = this.deps.runs
        .storeList({ group: benchGroup(job.id), limit: 100_000 })
        .filter(
          (run) =>
            run.spec.tags.execution_batch === plan.id &&
            run.spec.params.batchDigest === plan.digest,
        );
      if (existing.length > 1) throw new Error("multiple runs claim one fixed batch attempt");
      let run = existing[0];
      let issues: string[] = [];
      if (!run) {
        const reply = await this.solveSpec(job, trials[0] as Trial, {
          plan,
          trials: trials.map((member) => this.context(job, member).trial),
        });
        if (this.deps.store.getJob(job.id)?.state === "cancelled") return;
        issues = reply.issues;
        run = await this.submitRun(job, trials[0] as Trial, "solve", reply.spec);
      }
      const solve = this.deps.runs.get(run.id) ?? run;
      this.deps.store.tx(() => {
        for (const member of trials) {
          const fresh = this.deps.store.getTrial(member.id) as Trial;
          fresh.solveRunId = solve.id;
          if (fresh.state === "pending") fresh.state = "solving";
          if (fresh.state === "done" && fresh.outcome) fresh.outcome.cleanup = cleanupOf(solve);
          fresh.issues = [...new Set([...fresh.issues, ...issues])];
          this.deps.store.putTrial(fresh);
        }
      });
      await this.cancelIfJobCancelled(job.id, t, run.id);
      this.advanceAll(trials.map((member) => member.id));
    } catch (e) {
      for (const member of this.deps.store.trials(job.id))
        if (member.batch?.plan.id === plan.id && member.state === "pending")
          this.skipped(member, "invalid", `batch solve rejected: ${(e as Error).message}`);
    } finally {
      this.batchBusy.delete(plan.id);
    }
  }

  hasEpisodeEvidence(t: Trial, solve: Run): boolean {
    const member = t.batch?.plan.members[t.batch.index];
    return Boolean(
      member &&
        existsSync(
          join(
            this.deps.runs.dirs(solve.id).output,
            "episodes",
            member.episodeId,
            "evidence-manifest.json",
          ),
        ),
    );
  }

  private async stepSolving(job: BenchJob, t: Trial, solve: Run): Promise<void> {
    if (!isTerminal(solve.state)) return this.cancelIfJobCancelled(job.id, t, solve.id);
    if (t.batch && solve.cleanup === "pending") return;
    if (job.spec.calibration?.mode === "policy" && this.cancelled(job.id, t)) {
      const outcome = classify(solve, null, null, t.issues);
      outcome.evaluation = "unknown";
      outcome.score = null;
      outcome.issues.push(
        job.calibrationExpiredAt
          ? "policy calibration budget exhausted"
          : "policy integration check cancelled",
      );
      return this.finish(t, outcome);
    }
    const batchEvidence = this.hasEpisodeEvidence(t, solve);
    const sv = solveVerdict(solve);
    // An Agent that could not reach or use its model left nothing worth verifying; an explicit
    // rescore (history kept) verifies anyway, and an after phase has already verified.
    const agent = t.history.length === 0 ? await this.agentFailure(solve) : null;
    if (agent && !solve.spec.after)
      return this.finish(t, classify(solve, null, null, t.issues, agent));
    if ((!sv.verify || this.cancelled(job.id, t)) && !batchEvidence) {
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
      const reply = await this.deps.adapter(b).verify(trial, this.ref(solve));
      spec = toRunSpec(reply.spec, trial.method, b, "verify", () =>
        this.deps.agentDef(trial.method),
      );
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
        score = await this.deps.adapter(b).score(trial, this.ref(solve), this.ref(verify));
      } catch (e) {
        const message = (e as Error).message;
        // A failing adapter is the benchmark's scorer; anything else is Orbit's own fault.
        const own = !(e instanceof AdapterError);
        if (own) this.deps.log?.(`bench trial ${t.id}: scoring: ${(e as Error).stack ?? message}`);
        score = {
          score: null,
          maxScore: 1,
          issues: [own ? `score: Orbit error: ${message}` : `score: ${message}`],
          invalid: true,
          ...(own ? { failure: "infra" as const } : {}),
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
    }
    const agent = await this.agentFailure(solve);
    const outcome = classify(solve, verify, score, t.issues, agent, {
      independentEpisode: Boolean(t.batch),
    });
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
