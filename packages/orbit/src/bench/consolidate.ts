import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AuthEntry } from "../auth/index.ts";
import {
  BenchConsolidate,
  type BenchConsolidateInput,
  type BenchConsolidateResult,
  type BenchJob,
  type BenchJobDetail,
  type Benchmark,
  type Run,
  sampleKey,
  sampleLabel,
  type Trial,
  trialRunIds,
} from "../contracts/index.ts";
import { UserError } from "../runs/errors.ts";
import type { AgentFailure } from "../sessions/index.ts";
import { batchConditions } from "./batches.ts";
import { agentFailureIssue, agentFailureKind, shouldCheckAgentFailure } from "./classify.ts";
import { executionCapabilities } from "./revision.ts";
import { executionBudget, isValid } from "./summary.ts";
import { taskSetDigest } from "./task-sets.ts";

/** Group of a job's runs, so the run list and notifications see a job as one group. */
export const benchGroup = (jobId: string) => `bench-${jobId}`;

function benchmarkSettings(b: Benchmark) {
  return {
    adapter: b.adapter,
    path: b.path,
    config: b.config,
    env: b.env,
    passEnv: b.passEnv,
    resources: b.resources,
  };
}

export const sameMethodSetup = (a: BenchJob, b: BenchJob) => {
  if (!isDeepStrictEqual(a.revisions, b.revisions)) return false;
  if (a.spec.benchmark !== b.spec.benchmark || !isDeepStrictEqual(a.spec.methods, b.spec.methods))
    return false;
  if (!a.benchmarkSnapshot && !b.benchmarkSnapshot) return true;
  return Boolean(
    a.benchmarkSnapshot &&
      b.benchmarkSnapshot &&
      isDeepStrictEqual(
        benchmarkSettings(a.benchmarkSnapshot),
        benchmarkSettings(b.benchmarkSnapshot),
      ) &&
      isDeepStrictEqual(a.source, b.source) &&
      isDeepStrictEqual(
        executionCapabilities(a.capabilities),
        executionCapabilities(b.capabilities),
      ),
  );
};

export function consolidateOptions(id: string, input: BenchConsolidateInput) {
  const f = BenchConsolidate.parse(input);
  if (f.appendTasks && f.pruneInvalid)
    throw new UserError(
      "appendTasks preserves invalid artifacts; do not combine it with pruneInvalid",
    );
  if (f.replaceFailed && f.pruneInvalid)
    throw new UserError(
      "replaceFailed preserves retry artifacts; do not combine it with pruneInvalid",
    );
  const sources = [...new Set(f.sources)];
  if (sources.includes(id)) throw new UserError("target cannot also be a source");
  return { ...f, sources };
}

export function equivalentTransport(a: BenchJob, b: BenchJob, transport: Transport): boolean {
  if (!isDeepStrictEqual(a.revisions, b.revisions)) return false;
  if (Boolean(a.benchmarkSnapshot) !== Boolean(b.benchmarkSnapshot)) return false;
  const left = a.benchmarkSnapshot ?? transport.benchmarks.get(a.spec.benchmark);
  const right = b.benchmarkSnapshot ?? transport.benchmarks.get(b.spec.benchmark);
  if (!left || !right || !isDeepStrictEqual(a.source, b.source)) return false;
  if (
    !isDeepStrictEqual(executionCapabilities(a.capabilities), executionCapabilities(b.capabilities))
  )
    return false;
  const env = (v: Record<string, string>) =>
    Object.fromEntries(Object.entries(v).filter(([k]) => !/^(https?|all|no)_proxy$/i.test(k)));
  const benchmark = (v: Benchmark) => ({ ...benchmarkSettings(v), env: env(v.env) });
  if (!isDeepStrictEqual(benchmark(left), benchmark(right))) return false;
  if (a.spec.methods.length !== b.spec.methods.length) return false;
  return a.spec.methods.every((m, i) => {
    const n = b.spec.methods[i];
    if (!n || !isDeepStrictEqual({ ...m, auth: undefined }, { ...n, auth: undefined }))
      return false;
    if (m.auth === n.auth) return true;
    const x = m.auth ? transport.profiles.get(m.auth) : null;
    const y = n.auth ? transport.profiles.get(n.auth) : null;
    if (!x || !y || x.secret !== y.secret) return false;
    const profile = (v: typeof x.profile) => ({
      harness: v.harness,
      kind: v.kind,
      model: v.model,
      baseUrl: v.baseUrl,
      env: env(v.env),
    });
    return isDeepStrictEqual(profile(x.profile), profile(y.profile));
  });
}

export interface Transport {
  benchmarks: ReadonlyMap<string, Benchmark>;
  profiles: ReadonlyMap<string, AuthEntry>;
}

export function planConsolidation(input: {
  target: BenchJobDetail;
  donors: BenchJobDetail[];
  oldRuns: ReadonlyMap<string, Run>;
  failures: ReadonlyMap<string, AgentFailure>;
  flags: BenchConsolidateInput;
  transport?: Transport;
}) {
  if ([input.target, ...input.donors].some((d) => d.job.spec.calibration?.mode === "policy"))
    throw new UserError(
      "policy integration checks must retain their own bounded execution; consolidation is not supported",
    );
  const target = structuredClone(input.target);
  const donors = structuredClone(input.donors);
  const { oldRuns, failures } = input;
  const transport = input.transport ?? { benchmarks: new Map(), profiles: new Map() };
  const id = target.job.id;
  const f = consolidateOptions(id, input.flags);
  const sources = f.sources;
  const all = [target, ...donors];
  const reclassified: BenchConsolidateResult["reclassified"] = [];
  for (const d of all)
    for (const t of d.trials) {
      const failure = t.solveRunId ? failures.get(t.solveRunId) : null;
      const run = t.solveRunId ? oldRuns.get(t.solveRunId) : null;
      if (!failure || !run || !shouldCheckAgentFailure(run)) continue;
      const issue = agentFailureIssue(failure);
      let changed = false;
      // A valid score, or an unknown one (e.g. its verify run was lost), that only measures the setup.
      for (const outcome of [t.outcome, ...t.history.map((h) => h.outcome)]) {
        if (outcome?.evaluation !== "valid" && outcome?.evaluation !== "unknown") continue;
        outcome.evaluation = "invalid";
        outcome.failure = agentFailureKind(failure);
        outcome.issues = [...new Set([...outcome.issues, issue])];
        changed = true;
      }
      if (changed)
        reclassified.push({ job: d.job.id, trial: t.id, task: t.task, kind: failure.kind });
    }
  const newlyInvalid = new Set(reclassified.map((r) => r.trial));
  const key = (t: Trial) => JSON.stringify([t.method, sampleKey(t)]);
  const trials = new Map(target.trials.map((t) => [key(t), structuredClone(t)]));
  const adopted: BenchConsolidateResult["adopted"] = [];
  const adoptedKeys = new Set<string>();
  const taskIds = new Set(target.job.spec.tasks);
  const originalTaskIds = new Set(taskIds);
  const resources = { ...target.job.resources };
  let next = target.trials.length;
  const ids = new Set(target.trials.map((t) => t.id));
  for (const d of donors) {
    if (
      (!sameMethodSetup(d.job, target.job) &&
        !(f.allowTransportDifferences && equivalentTransport(target.job, d.job, transport))) ||
      Boolean(d.job.spec.samplePlan) !== Boolean(target.job.spec.samplePlan) ||
      (Boolean(d.job.spec.samplePlan) &&
        !isDeepStrictEqual(d.job.spec.samplePlan, target.job.spec.samplePlan)) ||
      d.job.spec.seeds !== target.job.spec.seeds ||
      d.job.spec.timeoutMin !== target.job.spec.timeoutMin ||
      d.job.spec.batchSize !== target.job.spec.batchSize ||
      !isDeepStrictEqual(d.job.spec.options, target.job.spec.options) ||
      !isDeepStrictEqual(d.job.metrics, target.job.metrics)
    )
      throw new UserError(`incompatible source job ${d.job.id}`);
    for (const t of d.trials) {
      if (adoptedKeys.has(key(t)))
        throw new UserError(
          `duplicate ${originalTaskIds.has(t.task) ? "source" : "appended"} trial ${t.task} / ${t.method} / ${sampleLabel(t)}`,
        );
      const prev = trials.get(key(t));
      if (prev && !isDeepStrictEqual(batchConditions(prev), batchConditions(t)))
        throw new UserError(
          "retry batch prefix or random-stream scope differs from the original attempt",
        );
      if (!prev) {
        if (!f.appendTasks || originalTaskIds.has(t.task))
          throw new UserError(`source trial ${t.id} is not in the target matrix`);
        let newId: string;
        do {
          newId = `${id}.${String(++next).padStart(5, "0")}`;
        } while (ids.has(newId));
        ids.add(newId);
        taskIds.add(t.task);
        const override = d.job.resources?.[t.task];
        if (override) resources[t.task] = override;
        trials.set(key(t), { ...t, id: newId, jobId: id });
        adopted.push({ task: t.task, sourceJob: d.job.id, sourceTrial: t.id, trial: newId });
        adoptedKeys.add(key(t));
        continue;
      }
      if (!originalTaskIds.has(t.task))
        throw new UserError(`duplicate appended trial ${t.task} / ${t.method} / ${sampleLabel(t)}`);
      const protectedTarget =
        isValid(prev) || prev.history.some((h) => h.outcome.evaluation === "valid");
      const retrySucceeded = t.solveRunId && oldRuns.get(t.solveRunId)?.state === "succeeded";
      const replaceFailed =
        f.replaceFailed &&
        (!prev.batch || !protectedTarget) &&
        retrySucceeded &&
        prev.solveRunId &&
        oldRuns.get(prev.solveRunId)?.state === "failed";
      const retainInvalid =
        f.replaceFailed &&
        !protectedTarget &&
        t.solveRunId &&
        ["succeeded", "failed"].includes(oldRuns.get(t.solveRunId)?.state ?? "") &&
        t.outcome?.evaluation === "invalid" &&
        !t.history.some((h) => h.outcome.evaluation === "valid");
      if (isValid(t) || retainInvalid) {
        if (!isDeepStrictEqual(executionBudget(d.job, t.task), executionBudget(target.job, t.task)))
          throw new UserError(
            `incompatible source job ${d.job.id}: execution budget for ${t.task}`,
          );
        if (f.pruneInvalid && newlyInvalid.has(prev.id))
          throw new UserError(
            `trial ${prev.id} was just reclassified; review it without sources before pruning`,
          );
        if (protectedTarget && !replaceFailed)
          throw new UserError(`refusing to replace valid trial ${prev.id}`);
        const priorAttempts =
          t.batch || prev.batch
            ? [
                ...(prev.priorAttempts ?? []),
                ...(prev.solveRunId
                  ? [
                      {
                        solveRunId: prev.solveRunId,
                        verifyRunId: prev.verifyRunId,
                        batch: prev.batch,
                        outcome: prev.outcome,
                        history: prev.history,
                      },
                    ]
                  : []),
                ...(t.priorAttempts ?? []),
              ]
            : undefined;
        trials.set(key(t), {
          ...t,
          id: prev.id,
          jobId: id,
          createdAt: prev.createdAt,
          ...(priorAttempts?.length ? { priorAttempts } : {}),
        });
        adopted.push({ task: t.task, sourceJob: d.job.id, sourceTrial: t.id, trial: prev.id });
        adoptedKeys.add(key(t));
      } else if (
        !f.pruneInvalid ||
        newlyInvalid.has(t.id) ||
        t.outcome?.evaluation !== "invalid" ||
        t.history.some((h) => h.outcome.evaluation === "valid")
      ) {
        throw new UserError(`source trial ${t.id} has no valid result to adopt`);
      }
    }
  }
  if (f.pruneInvalid)
    for (const t of trials.values()) {
      if (newlyInvalid.has(t.id)) continue;
      t.history = t.history.filter((h) => h.outcome.evaluation !== "invalid");
      if (t.outcome?.evaluation === "invalid") {
        t.verifyRunId = null;
        if (!t.history.length) t.solveRunId = null;
      }
    }
  const retained = new Set([...trials.values()].flatMap(trialRunIds));
  const removedRuns = [...oldRuns.keys()].filter((rid) => !retained.has(rid));
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        adopted: [...adopted].sort((a, b) => a.trial.localeCompare(b.trial)),
        reclassified: [...reclassified].sort((a, b) => a.trial.localeCompare(b.trial)),
        removedRuns: [...removedRuns].sort(),
        removedJobs: [...sources].sort(),
      }),
    )
    .digest("hex");
  if (!f.dryRun && f.expect !== undefined && f.expect !== digest)
    throw new UserError("plan changed since preview; preview again");
  const out: BenchConsolidateResult = {
    digest,
    dryRun: f.dryRun,
    adopted,
    reclassified,
    removedJobs: sources,
    removedRuns,
    leftovers: [],
  };
  const moved: Run[] = [];
  const movedIds = new Set<string>();
  for (const a of adopted) {
    const t = [...trials.values()].find((t) => t.id === a.trial) as Trial;
    for (const rid of trialRunIds(t)) {
      if (movedIds.has(rid)) continue;
      movedIds.add(rid);
      const r = structuredClone(oldRuns.get(rid) as Run);
      if (t.batch && r.spec.tags.job === id) continue;
      r.folder = target.job.folder;
      r.spec.group = benchGroup(id);
      r.spec.tags = {
        ...r.spec.tags,
        ...(t.sampleRef
          ? {
              execution_trial:
                r.spec.tags.execution_trial ??
                r.spec.tags.source_trial ??
                r.spec.tags.trial ??
                a.sourceTrial,
            }
          : {}),
        job: id,
        trial: t.id,
        source_job: a.sourceJob,
        source_trial: a.sourceTrial,
        source_benchmark: donors.find((d) => d.job.id === a.sourceJob)?.job.spec.benchmark ?? "",
      };
      r.note = [
        r.note,
        `Consolidated from ${a.sourceJob} / ${a.sourceTrial}; run ID and artifacts retained.`,
      ]
        .filter(Boolean)
        .join("\n");
      moved.push(r);
    }
  }
  if (target.job.taskFile && taskSetDigest(taskIds) !== taskSetDigest(target.job.spec.tasks))
    throw new UserError(
      "cannot append tasks to a job submitted from a task file; submit a new job",
    );
  const job = {
    ...target.job,
    ...(target.job.taskSet !== undefined ||
    taskSetDigest(taskIds) !== taskSetDigest(target.job.spec.tasks)
      ? { taskSet: taskSetDigest(taskIds) }
      : {}),
    spec: { ...target.job.spec, tasks: [...taskIds] },
    resources: Object.keys(resources).length ? resources : null,
    state: "done" as const,
    endedAt:
      [...trials.values()]
        .map((t) => t.endedAt)
        .filter((x): x is string => !!x)
        .sort()
        .at(-1) ?? target.job.endedAt,
  };
  return { ...out, job, trials: [...trials.values()], moved };
}
