// Calibration jobs after submission (design §9.15): the one rescore from saved evidence once all
// trials have ended and, for policy integration checks, the time budget and when execution ended.
import {
  type BenchJob,
  type BenchRescoreInput,
  type BenchRescoreResult,
  type CalibrationReport,
  calibrationExecutionEnd,
  calibrationReport,
  calibrationRunsClean,
  type Run,
  type Trial,
  trialRunIds,
} from "../contracts/index.ts";
import { nowIso } from "../lib/ids.ts";
import type { RunService } from "../runs/service.ts";
import type { Store } from "../store/index.ts";
import { benchGroup } from "./consolidate.ts";

export interface CalibrationDeps {
  store: Store;
  runs: RunService;
  log?: (msg: string) => void;
  /** Whether the bench service has stopped; then no timer or rescore is started. */
  stopped: () => boolean;
  cancel: (id: string) => Promise<unknown>;
  rescore: (id: string, input: BenchRescoreInput) => BenchRescoreResult;
}

/** Linked Runs plus every Run tagged for the job, including ones persisted before linkage. */
export function ownedRuns(
  runs: RunService,
  job: BenchJob,
  trials: Trial[],
): Map<string, Run | null> {
  const owned = new Map(trials.flatMap(trialRunIds).map((id) => [id, runs.get(id)] as const));
  // A submitted Run is durable before its Trial linkage is written.
  for (const run of runs.storeList({ group: benchGroup(job.id), limit: 100_000 }))
    if (run.spec.tags.job === job.id) owned.set(run.id, run);
  return owned;
}

/** When a policy check's budget runs out (epoch ms); null for other jobs and ended checks. */
export function policyDeadline(job: BenchJob): number | null {
  const c = job.spec.calibration;
  return c?.mode === "policy" && !job.calibrationExecutionEndedAt
    ? Date.parse(job.createdAt) + (c.budgetMin as number) * 60_000
    : null;
}

export class CalibrationLifecycle {
  private readonly deps: CalibrationDeps;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: CalibrationDeps) {
    this.deps = deps;
  }

  /** The report of a calibration job, or null for other jobs. */
  report(job: BenchJob, trials: Trial[]): CalibrationReport | null {
    const runs =
      job.spec.calibration?.mode === "policy" ? ownedRuns(this.deps.runs, job, trials) : undefined;
    return calibrationReport(job, trials, runs);
  }

  /** Expire a policy check when its budget runs out. */
  arm(job: BenchJob): void {
    const deadline = policyDeadline(job);
    if (deadline === null || this.deps.stopped() || this.timers.has(job.id)) return;
    const timer = setTimeout(
      () => {
        this.timers.delete(job.id);
        void this.expire(job.id).catch((e) =>
          this.deps.log?.(`calibration budget ${job.id}: ${e.message}`),
        );
      },
      Math.max(1, deadline - Date.now()),
    );
    timer.unref();
    this.timers.set(job.id, timer);
  }

  disarm(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Settle a stored job and expire it if its budget ran out while the daemon was down. */
  async expireIfDue(stored: BenchJob): Promise<void> {
    const deadline = policyDeadline(this.settle(stored));
    if (deadline !== null && Date.now() >= deadline) await this.expire(stored.id);
  }

  /** The budget ran out: record it, cancel the job and finish it once no trial is open. */
  async expire(id: string): Promise<void> {
    const stored = this.deps.store.getJob(id);
    if (!stored) return;
    const job = this.settle(stored);
    const deadline = policyDeadline(job);
    if (deadline === null || Date.now() < deadline) return;
    if (!job.calibrationExpiredAt) {
      job.calibrationExpiredAt = nowIso();
      this.deps.store.putJob(job);
    }
    await this.deps.cancel(id);
    if (!this.deps.store.hasOpenTrials(id)) this.afterTrials(id);
  }

  /** A calibration job's trials have all ended: rescore it once from saved evidence, then finish. */
  afterTrials(id: string): void {
    if (this.deps.stopped()) return;
    const job = this.deps.store.getJob(id);
    const c = job?.spec.calibration;
    if (!job || !c || this.deps.store.hasOpenTrials(id)) return;
    if (c.mode === "policy" && this.settle(job).calibrationExecutionEndedAt) return;
    if (job.rescore?.state === "done") return;
    const done = (note?: string) => {
      const fresh = this.deps.store.getJob(id) ?? job;
      fresh.rescore = { state: "done", ...(note ? { note } : {}) };
      this.deps.store.putJob(fresh);
      this.settle(fresh);
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
      const first = c.mode === "policy" ? this.deps.store.trials(id)[0]?.id : undefined;
      const r = this.deps.rescore(id, first ? { trials: [first] } : {});
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

  /**
   * Record when a policy check's execution ended, and end the job once its Runs are cleaned up.
   * Other jobs are returned unchanged.
   */
  settle(job: BenchJob): BenchJob {
    if (job.spec.calibration?.mode !== "policy") return job;
    const trials = this.deps.store.trials(job.id);
    const runs = ownedRuns(this.deps.runs, job, trials);
    const ended = calibrationExecutionEnd(job, trials, runs);
    if (!ended) return job;
    let changed = false;
    if (!job.calibrationExecutionEndedAt) {
      job.calibrationExecutionEndedAt = ended;
      job.rescore = { ...job.rescore, state: "done" };
      job.endedAt = null;
      const deadline =
        Date.parse(job.createdAt) + (job.spec.calibration.budgetMin as number) * 60_000;
      if (Date.parse(ended) > deadline && !job.calibrationExpiredAt)
        job.calibrationExpiredAt = ended;
      this.disarm(job.id);
      changed = true;
    }
    if (!job.endedAt && !this.deps.store.hasOpenTrials(job.id) && calibrationRunsClean(runs)) {
      job.endedAt = nowIso();
      changed = true;
    }
    if (changed) this.deps.store.putJob(job);
    return job;
  }
}
