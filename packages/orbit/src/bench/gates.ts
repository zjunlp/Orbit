import { createHash } from "node:crypto";
import {
  type BenchJob,
  type BenchReport,
  type GateEvidence,
  type GatePolicy,
  GateRecord,
  type GateReportRef,
  GateSubmission,
  parseTaskFile,
} from "../contracts/index.ts";
import { newId, nowIso } from "../lib/ids.ts";
import { NotFoundError, UserError } from "../runs/service.ts";
import type { Store } from "../store/index.ts";
import { gate, gateBenchmark } from "./gate.ts";

/** Resolve only stored evidence. No report backfills, Run reads or benchmark execution. */
export function resolveGateEvidence(store: Store, input: unknown, allowAmbiguous = false) {
  const request = GateSubmission.parse(input);
  const { policy, parent, child, mode } = request;
  validateGateTasks(policy, request.taskSets);

  const jobs = new Map<string, BenchJob>();
  const reports = new Map<string, BenchReport>();
  const reportKey = (r: BenchReport) => JSON.stringify([r.jobId, r.revision]);
  // Prior verdicts preserve assessed history even after a job is deleted or consolidated.
  for (const saved of store.gateRecords()) {
    for (const job of saved.evidence.jobs) jobs.set(job.id, job);
    for (const report of saved.evidence.reports) reports.set(reportKey(report), report);
  }
  for (const job of store.listJobs(-1)) {
    jobs.set(job.id, job);
    for (const report of store.reports(job.id)) reports.set(reportKey(report), report);
  }
  const allJobs = [...jobs.values()];
  const revision = (id: string) =>
    allJobs.flatMap((j) => Object.values(j.revisions)).find((r) => r.revision === id);
  const parentRevision = revision(parent),
    childRevision = revision(child);
  if (!parentRevision || !childRevision)
    throw new NotFoundError("parent or child configuration revision not found");
  const related = new Set([parent, child]);
  for (const job of allJobs)
    for (const r of Object.values(job.revisions))
      if (
        policy.final.some((d) => d.agents.includes(r.basis.agent)) &&
        [parentRevision.basis.bundleDigest, childRevision.basis.bundleDigest].includes(
          r.basis.bundleDigest,
        )
      )
        related.add(r.revision);
  const allReports = [...reports.values()];
  const includedJobs = new Set<string>();
  let changed = true;
  while (changed) {
    const before = related.size + includedJobs.size;
    for (const job of allJobs) {
      for (const [method, r] of Object.entries(job.revisions)) {
        const ancestor = job.spec.lineage[method]?.parent;
        if (related.has(r.revision) || (ancestor && related.has(ancestor))) {
          related.add(r.revision);
          if (ancestor) related.add(ancestor);
          includedJobs.add(job.id);
        }
      }
      if (!includedJobs.has(job.id)) continue;
      for (const r of Object.values(job.revisions)) related.add(r.revision);
      const learned = new Set(Object.values(job.spec.lineage).flatMap((l) => l.informedBy));
      for (const report of allReports)
        if (report.methods.some((m) => m.entries.some((e) => learned.has(e.trial))))
          includedJobs.add(report.jobId);
    }
    changed = related.size + includedJobs.size !== before;
  }
  const evidence: GateEvidence = {
    jobs: allJobs.filter((j) => includedJobs.has(j.id)),
    reports: allReports.filter((r) => includedJobs.has(r.jobId)),
    taskSets: request.taskSets,
    selections: [...request.selections],
  };
  const declarations = [
    { set: "gate", dataset: policy.gate, agent: null },
    ...policy.guard.map((dataset, i) => ({ set: `guard:${i}`, dataset, agent: null })),
    ...policy.final.flatMap((dataset, i) =>
      dataset.agents.map((agent) => ({ set: `final:${i}:${agent}`, dataset, agent })),
    ),
  ];
  if (
    new Set(evidence.selections.map((s) => s.set)).size !== evidence.selections.length ||
    evidence.selections.some((s) => !declarations.some((d) => d.set === s.set))
  )
    throw new UserError("duplicate or unknown report selection sets");
  for (const selection of evidence.selections)
    for (const ref of [selection.parent, selection.child])
      if (
        !evidence.reports.some(
          (r) =>
            r.jobId === ref.job &&
            r.revision === ref.revision &&
            r.methods.some((m) => m.method === ref.method),
        )
      )
        throw new UserError(
          `selected report is unavailable or unrelated: ${ref.job}@${ref.revision}:${ref.method}`,
        );
  const sets = [];
  for (const { set, dataset, agent } of declarations) {
    const candidates = (target: typeof parentRevision): GateReportRef[] =>
      evidence.reports.flatMap((report) => {
        const job = jobs.get(report.jobId);
        if (
          !job ||
          gateBenchmark(job) !== dataset.benchmark ||
          job.taskFile?.sha256 !== dataset.tasks.sha256 ||
          report.metric !== policy.metric
        )
          return [];
        return report.methods
          .filter((m) => {
            const r = job.revisions[m.method];
            return (
              r &&
              (agent
                ? r.basis.agent === agent && r.basis.bundleDigest === target.basis.bundleDigest
                : r.revision === target.revision)
            );
          })
          .map((m) => ({ job: job.id, revision: report.revision, method: m.method }));
      });
    const a = candidates(parentRevision),
      b = candidates(childRevision);
    sets.push({ set, dataset, agent, parent: a, child: b });
    if (evidence.selections.some((s) => s.set === set)) continue;
    if (a.length > 1 || b.length > 1 || (mode === "calibration-aa" && a.length)) {
      if (allowAmbiguous) continue;
      const choices = [...new Set([...a, ...b].map((r) => `${r.job}@${r.revision}:${r.method}`))];
      throw new UserError(
        `explicit report selections required for ${set}; use --reports FILE: ${choices.join(", ")}`,
      );
    }
    if (a[0] && b[0]) evidence.selections.push({ set, parent: a[0], child: b[0] });
  }
  return { request, evidence, sets, parentRevision, childRevision };
}

export function evaluateGate(store: Store, input: unknown): GateRecord {
  return store.tx(() => {
    const { request, evidence } = resolveGateEvidence(store, input);
    const { parent, child, policy, mode } = request;
    const record = GateRecord.parse({
      id: newId(),
      createdAt: nowIso(),
      evaluator: "orbit-gate/1",
      mode,
      policy,
      evidence,
      verdict: gate(parent, child, policy, evidence, mode),
    });
    store.addGate(record);
    return record;
  });
}

export function validateGateTasks(policy: GatePolicy, taskSets: GateEvidence["taskSets"]) {
  const datasets = [policy.gate, ...policy.guard, ...policy.final];
  if (datasets.length > 32) throw new UserError("at most 32 gate datasets are supported");
  const snapshots = new Map(taskSets.map((s) => [s.file, s]));
  if (snapshots.size !== taskSets.length) throw new UserError("duplicate task files");
  let bytes = 0;
  for (const snapshot of taskSets) {
    bytes += Buffer.byteLength(snapshot.content);
    if (Buffer.byteLength(snapshot.content) > 8 * 1024 * 1024 || bytes > 32 * 1024 * 1024)
      throw new UserError("gate task snapshots exceed the 8 MiB per-file or 32 MiB total limit");
    if (!datasets.some((d) => d.tasks.file === snapshot.file))
      throw new UserError(`task file is not declared in the policy: ${snapshot.file}`);
    try {
      parseTaskFile(snapshot.content);
    } catch (error) {
      throw new UserError((error as Error).message);
    }
  }
  for (const dataset of datasets) {
    const snapshot = snapshots.get(dataset.tasks.file);
    if (
      !snapshot ||
      createHash("sha256").update(snapshot.content).digest("hex") !== dataset.tasks.sha256
    )
      throw new UserError(`missing or changed task file: ${dataset.tasks.file}`);
  }
}
