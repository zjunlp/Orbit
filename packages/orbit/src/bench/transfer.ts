import {
  type BenchJob,
  type GateRecord,
  type GateReportRef,
  type TransferAssessment,
  type TransferColumn,
  type TransferCondition,
  TransferMatrix,
  TransferQuery,
  type TransferRow,
} from "../contracts/index.ts";
import { resolveMetrics } from "../contracts/metrics.ts";
import { gateBenchmark } from "./gate.ts";
import { contentDigest } from "./samples.ts";
import { evaluationConditions } from "./summary.ts";

function bundle(record: GateRecord, revision: string): string | null {
  const found = record.evidence.jobs.flatMap((j) =>
    Object.values(j.revisions).filter((r) => r.revision === revision),
  );
  if (
    !found.length ||
    found.some(
      (r) =>
        r.approximate ||
        contentDigest(r.basis).slice(7, 19) !== r.revision ||
        !/^[a-f0-9]{64}$/.test(r.basis.bundleDigest ?? ""),
    )
  )
    return null;
  const digests = new Set(found.map((r) => r.basis.bundleDigest));
  return digests.size === 1 ? (found[0]?.basis.bundleDigest ?? null) : null;
}

function condition(job: BenchJob, method: string, metricName: string): TransferCondition | null {
  const revision = job.revisions[method];
  if (!revision) return null;
  const { bundleDigest: _bundle, ...basis } = revision.basis;
  const identity =
    job.benchmarkSnapshot?.labels?.identity ??
    job.capabilities?.identity ??
    job.taskFile?.frozen?.manifest.benchmark.identity;
  const metrics = resolveMetrics(job.metrics);
  const evaluation = evaluationConditions(job, job.spec.tasks);
  const budgets = new Map<string, TransferCondition["budgets"][number]>();
  for (const { task: _task, ...budget } of evaluation.budgets) {
    const id = contentDigest(budget);
    const group = budgets.get(id);
    if (group) group.tasks++;
    else budgets.set(id, { tasks: 1, ...budget });
  }
  return {
    digest: contentDigest({
      basis,
      approximate: revision.approximate,
      identity: identity ?? null,
      evaluation,
      methodPassEnv: [...(job.spec.methods.find((m) => m.name === method)?.passEnv ?? [])].sort(),
      metrics,
      seeds: job.spec.seeds,
      samplePlan: job.spec.samplePlan ?? null,
      bindings: job.resolvedBindings ?? null,
      checkpoint: job.spec.checkpoint ?? null,
      tasks: [...job.spec.tasks].sort(),
      taskSet: job.taskSet,
      taskFile: job.taskFile?.sha256 ?? null,
    }),
    benchmark: gateBenchmark(job),
    version: identity?.version ?? null,
    variant: identity?.variant ?? null,
    sourceCommit: job.source?.commit ?? null,
    agent: basis.agent,
    model: basis.model,
    effort: basis.effort,
    taskSet: job.taskSet ?? null,
    tasks: job.spec.tasks.length,
    metric: metrics.find((m) => m.name === metricName) ?? null,
    budgets: [...budgets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v),
  };
}

function selected(record: GateRecord, ref: GateReportRef | undefined, metric: string) {
  if (!ref) return null;
  const job = record.evidence.jobs.find((j) => j.id === ref.job);
  if (!job) return null;
  const report = record.evidence.reports.find(
    (r) => r.jobId === ref.job && r.revision === ref.revision,
  );
  return {
    condition: condition(job, ref.method, metric),
    revision: job.revisions[ref.method]?.revision,
    available: Boolean(report?.methods.some((m) => m.method === ref.method)),
  };
}

/** Read only archived assessments. Never pick reports, recalculate verdicts or average records. */
export function transferMatrix(records: GateRecord[], input: TransferQuery = {}): TransferMatrix {
  const query = TransferQuery.parse(input);
  const rows = new Map<string, TransferRow>();
  const columns = new Map<string, TransferColumn>();
  const omitted: TransferMatrix["omitted"] = [];
  for (const record of [...records].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )) {
    if (record.mode === "calibration-aa") {
      omitted.push({ record: record.id, reason: "calibration" });
      continue;
    }
    const parentBundle = bundle(record, record.verdict.inputs.parent);
    const childBundle = bundle(record, record.verdict.inputs.child);
    if (!parentBundle || !childBundle) {
      omitted.push({ record: record.id, reason: "unresolved-bundles" });
      continue;
    }
    if (
      query.parentBundle &&
      (query.parentBundle !== parentBundle || query.childBundle !== childBundle)
    )
      continue;
    if (parentBundle === childBundle) {
      omitted.push({ record: record.id, reason: "unchanged-bundle" });
      continue;
    }
    const id = contentDigest([parentBundle, childBundle]);
    const row = rows.get(id) ?? { id, parentBundle, childBundle, cells: [] };
    rows.set(id, row);
    const base = record.evidence.jobs
      .flatMap((j) => Object.values(j.revisions))
      .find((r) => r.revision === record.verdict.inputs.parent);
    const declarations = [
      { set: "gate", role: "gate" as const, dataset: record.policy.gate, agent: base?.basis.agent },
      ...record.policy.guard.map((dataset, i) => ({
        set: `guard:${i}`,
        role: "guard" as const,
        dataset,
        agent: base?.basis.agent,
      })),
      ...record.policy.final.flatMap((dataset, i) =>
        dataset.agents.map((agent) => ({
          set: `final:${i}:${agent}`,
          role: "final" as const,
          dataset,
          agent,
        })),
      ),
    ];
    for (const { set, role, dataset, agent } of declarations) {
      const selection = record.evidence.selections.find((s) => s.set === set);
      const metricName = dataset.metric ?? record.policy.metric;
      const a = selected(record, selection?.parent, metricName);
      const b = selected(record, selection?.child, metricName);
      const parent = a?.condition ?? null;
      const child = b?.condition ?? null;
      const column = {
        benchmark: dataset.benchmark,
        agent: agent ?? null,
        role,
        metric: metricName,
        taskFile: dataset.tasks.sha256,
        parent,
        child,
      };
      const columnId = contentDigest(column);
      columns.set(columnId, { id: columnId, ...column });
      const checks = record.verdict.checks.filter((c) => c.set === set || c.set === "global");
      const local = checks.filter((c) => c.set === set);
      const compatible = Boolean(parent && child && parent.digest === child.digest);
      const missing = !selection || !a?.available || !b?.available || !parent || !child;
      const incompatible =
        !missing &&
        (!compatible || local.some((c) => c.kind === "conditions" && c.status !== "pass"));
      const prerequisites = ["tasks", "reports", "conditions"] as const;
      const comparable =
        !missing &&
        !incompatible &&
        prerequisites.every((kind) => local.some((c) => c.kind === kind && c.status === "pass")) &&
        checks.some((c) => c.set === "global" && c.kind === "lineage" && c.status === "pass") &&
        !checks.some((c) => (c.kind === "lineage" || c.set === "global") && c.status !== "pass");
      const metricCheck = local.find(
        (c) => c.kind === "improvement" || c.kind === "non-inferiority",
      );
      const stat = comparable ? (metricCheck?.diff ?? null) : null;
      const delta =
        stat && parent?.metric
          ? parent.metric.higherIsBetter
            ? stat
            : {
                ...stat,
                mean: -stat.mean,
                ci: stat.ci ? ([-stat.ci[1], -stat.ci[0]] as [number, number]) : null,
              }
          : null;
      const status: TransferAssessment["status"] = missing
        ? "missing"
        : incompatible
          ? "incompatible"
          : !comparable || checks.some((c) => c.prerequisite && c.status !== "pass")
            ? "insufficient"
            : checks.some((c) => c.status === "fail")
              ? "fail"
              : !metricCheck || checks.some((c) => c.status !== "pass")
                ? "insufficient"
                : "pass";
      const taskSet = record.verdict.inputs.taskSets.find((t) => t.set === set);
      const assessment: TransferAssessment = {
        record: record.id,
        createdAt: record.createdAt,
        set,
        policyDigest: record.verdict.inputs.policyDigest,
        parentRevision: a?.revision ?? record.verdict.inputs.parent,
        childRevision: b?.revision ?? record.verdict.inputs.child,
        parent: selection?.parent ?? null,
        child: selection?.child ?? null,
        status,
        decision: record.verdict.decision,
        level: record.verdict.level,
        checks,
        delta,
        eligible: taskSet?.eligible ?? null,
        total: taskSet?.total ?? null,
        excluded: new Set(taskSet?.excluded.map((e) => e.task)).size,
        alpha: record.verdict.alpha,
      };
      const cell = row.cells.find((c) => c.column === columnId);
      if (cell) cell.assessments.push(assessment);
      else row.cells.push({ column: columnId, assessments: [assessment] });
    }
  }
  return TransferMatrix.parse({
    rows: [...rows.values()].sort((a, b) => a.id.localeCompare(b.id)),
    columns: [...columns.values()].sort(
      (a, b) =>
        a.benchmark.localeCompare(b.benchmark) ||
        (a.agent ?? "").localeCompare(b.agent ?? "") ||
        a.role.localeCompare(b.role) ||
        a.id.localeCompare(b.id),
    ),
    omitted,
  });
}
