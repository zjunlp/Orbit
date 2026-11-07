import { randomUUID } from "node:crypto";
import type { BenchJob, Trial } from "../contracts/index.ts";
import { contentDigest } from "./samples.ts";

/** Immutable membership only; Run and Trial remain the execution state machines. */
export function assignSolveBatches(job: BenchJob, trials: Trial[]): void {
  const size = job.spec.batchSize;
  if (!size) return;
  let sequence = 0;
  for (const method of job.spec.methods) {
    let group: Trial[] = [];
    let budget: string | null = null;
    const flush = () => {
      if (!group.length) return;
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
      group = [];
    };
    for (const trial of trials.filter((trial) => trial.method === method.name)) {
      const next = contentDigest({
        resources: job.resources?.[trial.task] ?? {},
        timeout: job.spec.timeoutMin ?? null,
      });
      if (next !== budget || group.length === size) flush();
      budget = next;
      group.push(trial);
    }
    flush();
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
