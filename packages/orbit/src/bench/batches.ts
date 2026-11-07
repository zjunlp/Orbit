import { randomUUID } from "node:crypto";
import type { BenchJob, Trial } from "../contracts/index.ts";
import { contentDigest } from "./samples.ts";
import { executionBudget } from "./summary.ts";

type BatchJob = Pick<BenchJob, "spec"> & Partial<Pick<BenchJob, "resources">>;

/**
 * Split ordered items into fixed sequential batches: at most `batchSize` long, never across a
 * change of effective budget. Planning and comparison conditions both use this one rule.
 */
export function splitBatches<T>(job: BatchJob, items: T[], task: (item: T) => string): T[][] {
  const size = job.spec.batchSize;
  if (!size) return [];
  const groups: T[][] = [];
  let budget: string | null = null;
  for (const item of items) {
    const { task: _, ...effective } = executionBudget(job, task(item));
    const next = contentDigest(effective);
    const last = groups.at(-1);
    if (last && next === budget && last.length < size) last.push(item);
    else groups.push([item]);
    budget = next;
  }
  return groups;
}

/** Immutable membership only; Run and Trial remain the execution state machines. */
export function assignSolveBatches(job: BenchJob, trials: Trial[]): void {
  if (!job.spec.batchSize) return;
  let sequence = 0;
  for (const method of job.spec.methods) {
    const own = trials.filter((trial) => trial.method === method.name);
    for (const group of splitBatches(job, own, (trial) => trial.task)) {
      const attemptId = randomUUID();
      const content = {
        version: 1 as const,
        id: `${job.id}.batch.${++sequence}`,
        attemptId,
        method: method.name,
        randomness:
          method.policySnapshot?.randomness.scope === "stateless"
            ? ("stateless" as const)
            : ("service" as const),
        members: group.map((trial) => ({
          trialId: trial.id,
          sampleRef: trial.sampleRef as string,
          episodeId: `${trial.id}.${attemptId}`,
        })),
      };
      const plan = { ...content, digest: contentDigest(content) };
      group.forEach((trial, index) => {
        trial.batch = { plan, index };
      });
    }
  }
}

/** A retry must reproduce the same complete service-stream prefix, even when only one result is adopted. */
export function batchConditions(trial: Trial): unknown {
  return trial.batch
    ? {
        index: trial.batch.index,
        randomness: trial.batch.plan.randomness,
        samples: trial.batch.plan.members.map((member) => member.sampleRef),
      }
    : null;
}
