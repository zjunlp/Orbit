import {
  type ExportTrialContext,
  isTerminal,
  type Outcome,
  type Run,
  sampleIdentity,
  type TrajectoryExportRequest,
  type Trial,
} from "../contracts/index.ts";
import { NotFoundError, UserError } from "../runs/service.ts";
import type { Store } from "../store/index.ts";

export interface ExportSelection {
  run: Run;
  contexts: ExportTrialContext[];
}

/** Freeze selection and scoring metadata before loading any local or worker evidence. */
export function selectTrajectories(
  store: Store,
  request: TrajectoryExportRequest,
): ExportSelection[] {
  const selected = new Map<string, ExportSelection>();
  const matches = (trial: Trial, outcome: Outcome | null) => {
    if (request.tasks.length && !request.tasks.includes(trial.task)) return false;
    if (request.methods.length && !request.methods.includes(trial.method)) return false;
    if (request.validOnly && outcome?.evaluation !== "valid") return false;
    if (request.outcome) {
      if (outcome?.evaluation !== "valid" || outcome.score === null || outcome.maxScore <= 0)
        return false;
      const pass = outcome.score >= outcome.maxScore;
      if (pass !== (request.outcome === "pass")) return false;
    }
    return true;
  };
  const add = (id: string, contexts: ExportTrialContext[]) => {
    const existing = selected.get(id);
    if (existing) {
      for (const context of contexts)
        if (!existing.contexts.some((c) => c.trial === context.trial && c.phase === context.phase))
          existing.contexts.push(context);
      return;
    }
    const run = store.getRun(id);
    if (!run) throw new NotFoundError(`Run ${id} not found`);
    if (!isTerminal(run.state) || run.cleanup !== "done")
      throw new UserError(`Run ${id} must be finished with confirmed cleanup`);
    selected.set(id, { run, contexts });
    if (selected.size > 1000)
      throw new UserError("export is limited to 1000 Runs; narrow the selection");
  };
  const context = (trial: Trial, id: string): ExportTrialContext | null => {
    const attempt = (trial.priorAttempts ?? []).find(
      (a) =>
        a.solveRunId === id || a.verifyRunId === id || a.history.some((h) => h.verifyRunId === id),
    );
    const source = attempt ?? trial;
    const history = source.history.find((h) => h.verifyRunId === id);
    const outcome = history?.outcome ?? source.outcome;
    if (!matches(trial, outcome)) return null;
    const job = store.getJob(trial.jobId);
    if (!job) throw new NotFoundError(`Job ${trial.jobId} not found`);
    const revision = job.revisions[trial.method];
    return {
      trial: trial.id,
      job: job.id,
      benchmark: job.spec.benchmark,
      task: trial.task,
      method: trial.method,
      revision: revision?.revision ?? null,
      revisionApproximate: revision?.approximate ?? null,
      sample: sampleIdentity(trial),
      phase: source.solveRunId === id ? "solve" : "verify",
      priorAttempt: Boolean(attempt),
      outcome: outcome
        ? {
            execution: outcome.execution,
            evaluation: outcome.evaluation,
            score: outcome.score,
            maxScore: outcome.maxScore,
            cleanup: outcome.cleanup,
          }
        : null,
    };
  };
  for (const id of new Set(request.runs)) {
    const trials = store.trialsByRun(id);
    const contexts = trials.map((t) => context(t, id)).filter((c) => c !== null);
    if (
      contexts.length ||
      (!trials.length &&
        !request.tasks.length &&
        !request.methods.length &&
        !request.validOnly &&
        !request.outcome)
    )
      add(id, contexts);
    else if (!store.getRun(id)) throw new NotFoundError(`Run ${id} not found`);
  }
  const trials = new Map<string, Trial>();
  for (const id of new Set(request.trials)) {
    const trial = store.getTrial(id);
    if (!trial) throw new NotFoundError(`Trial ${id} not found`);
    trials.set(id, trial);
  }
  for (const id of new Set(request.jobs)) {
    if (!store.getJob(id)) throw new NotFoundError(`Job ${id} not found`);
    for (const trial of store.trials(id)) trials.set(trial.id, trial);
  }
  for (const trial of trials.values()) {
    if (!trial.solveRunId) {
      if (matches(trial, trial.outcome)) throw new UserError(`Trial ${trial.id} has no solve Run`);
      continue;
    }
    const ctx = context(trial, trial.solveRunId);
    if (ctx) add(trial.solveRunId, [ctx]);
  }
  if (!selected.size) throw new UserError("no trajectories match the selection");
  for (const entry of selected.values()) {
    const owners = store.trialsByRun(entry.run.id);
    if (owners.some((trial) => !entry.contexts.some((ctx) => ctx.trial === trial.id)))
      throw new UserError(
        `Run ${entry.run.id} is shared with excluded trials; export the whole batch or use separate Runs`,
      );
  }
  return [...selected.values()].sort((a, b) => a.run.id.localeCompare(b.run.id));
}
