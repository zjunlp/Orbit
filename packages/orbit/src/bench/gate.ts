import { createHash } from "node:crypto";
import {
  type BenchJob,
  type BenchReport,
  type GateCheck,
  type GateEvidence,
  GatePolicy,
  type GatePolicyInput,
  type GateReportRef,
  GateVerdict,
  type MethodRevision,
  parseTaskFile,
  sampleKey,
} from "../contracts/index.ts";
import {
  alphaAt,
  lowerBound,
  mcnemarExact,
  nonInferior,
  pairedDiff,
  resolveMetrics,
  upperBound,
} from "../contracts/metrics.ts";
import { contentDigest } from "./samples.ts";
import { evaluationConditions, planDigest, REPORT_AGGREGATOR } from "./summary.ts";

type ReportMethod = BenchReport["methods"][number];
type Entry = ReportMethod["entries"][number];
const identity = (j: BenchJob) =>
  j.benchmarkSnapshot?.labels?.identity ??
  j.capabilities?.identity ??
  j.taskFile?.frozen?.manifest.benchmark.identity;
const benchmark = (j: BenchJob) => identity(j)?.id ?? j.spec.benchmark;
const setDigest = (ids: Iterable<string>) => contentDigest([...new Set(ids)].sort()).slice(7, 19);
const key = (job: string, revision: number) => JSON.stringify([job, revision]);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Only explicit immutable reports and frozen job metadata are read; no store, files or clock. */
export function gate(
  parent: string,
  child: string,
  input: GatePolicyInput,
  evidence: GateEvidence,
): GateVerdict {
  if (![parent, child].every((r) => /^[a-f0-9]{12}$/.test(r)))
    throw new Error("configuration revisions must be 12 hex digits");
  const policy = GatePolicy.parse(input);
  const checks: GateCheck[] = [];
  const regressions: GateVerdict["regressions"] = [];
  const taskSets: GateVerdict["inputs"]["taskSets"] = [];
  const add = (
    set: string,
    kind: GateCheck["kind"],
    status: GateCheck["status"],
    reason: string,
    required = true,
    prerequisite = true,
    extra: Partial<GateCheck> = {},
  ) => checks.push({ set, kind, status, reason, required, prerequisite, ...extra });
  const jobs = new Map(evidence.jobs.map((j) => [j.id, j]));
  const reports = new Map(evidence.reports.map((r) => [key(r.jobId, r.revision), r]));
  const notes = new Set<string>();
  if (jobs.size !== evidence.jobs.length || reports.size !== evidence.reports.length)
    notes.add("duplicate job or report references");
  if (new Set(evidence.selections.map((s) => s.set)).size !== evidence.selections.length)
    notes.add("duplicate evidence selections");
  if (new Set(evidence.taskSets.map((t) => t.file)).size !== evidence.taskSets.length)
    notes.add("duplicate task-file snapshots");
  interface Node {
    revision: MethodRevision;
    parents: Set<string>;
    informed: Set<string>;
  }
  const nodes = new Map<string, Node>();
  for (const j of evidence.jobs)
    for (const [method, revision] of Object.entries(j.revisions)) {
      if (contentDigest(revision.basis).slice(7, 19) !== revision.revision)
        notes.add(`revision basis digest mismatch: ${revision.revision}`);
      const node = nodes.get(revision.revision) ?? {
        revision,
        parents: new Set<string>(),
        informed: new Set<string>(),
      };
      if (contentDigest(node.revision) !== contentDigest(revision))
        notes.add(`conflicting revision metadata: ${revision.revision}`);
      const lineage = j.spec.lineage[method];
      if (lineage?.parent) node.parents.add(lineage.parent);
      for (const trial of lineage?.informedBy ?? []) node.informed.add(trial);
      nodes.set(revision.revision, node);
    }
  const ancestors = new Set<string>();
  const visit = (revision: string, stack = new Set<string>()): string | null => {
    if (stack.has(revision)) {
      notes.add("lineage contains a cycle");
      return null;
    }
    const node = nodes.get(revision);
    if (!node) {
      notes.add(`missing lineage revision: ${revision}`);
      return null;
    }
    ancestors.add(revision);
    if (node.parents.size > 1) {
      notes.add(`conflicting parents: ${revision}`);
      return null;
    }
    const ancestor = [...node.parents][0];
    return ancestor ? visit(ancestor, new Set([...stack, revision])) : revision;
  };
  const root = visit(child);
  if (parent === child || !nodes.get(child)?.parents.has(parent))
    notes.add("child must name the requested parent in its lineage");
  const learned: { benchmark: string; task: string; trial: string; revision: string }[] = [];
  const trialTasks = new Map<string, { benchmark: string; task: string }>();
  for (const r of evidence.reports) {
    const j = jobs.get(r.jobId);
    if (!j) {
      notes.add(`missing job for report: ${r.jobId}`);
      continue;
    }
    for (const m of r.methods)
      for (const e of m.entries) {
        const value = { benchmark: benchmark(j), task: e.task };
        const old = trialTasks.get(e.trial);
        if (old && contentDigest(old) !== contentDigest(value))
          notes.add(`conflicting task reference: ${e.trial}`);
        trialTasks.set(e.trial, value);
      }
  }
  for (const revision of [...ancestors].sort())
    for (const trial of [...(nodes.get(revision)?.informed ?? [])].sort()) {
      const task = trialTasks.get(trial);
      if (!task) notes.add(`missing informedBy evidence: ${trial}`);
      else learned.push({ ...task, trial, revision });
    }
  const rootOf = (revision: string, seen = new Set<string>()): string | null => {
    const node = nodes.get(revision);
    if (!node || seen.has(revision) || node.parents.size > 1) return null;
    const p = [...node.parents][0];
    return p ? rootOf(p, new Set([...seen, revision])) : revision;
  };
  const assessed = new Map<string, { time: number; job: string }>();
  for (const j of evidence.jobs) {
    if (benchmark(j) !== policy.gate.benchmark || j.taskFile?.sha256 !== policy.gate.tasks.sha256)
      continue;
    for (const [method, revision] of Object.entries(j.revisions))
      for (const r of evidence.reports) {
        if (
          r.jobId !== j.id ||
          r.metric !== policy.metric ||
          !r.methods.some((m) => m.method === method)
        )
          continue;
        const time = Date.parse(j.createdAt);
        if (!Number.isFinite(time)) {
          notes.add("job timestamps must identify candidate order");
          continue;
        }
        const old = assessed.get(revision.revision);
        if (!old || time < old.time || (time === old.time && compare(j.id, old.job) < 0))
          assessed.set(revision.revision, { time, job: j.id });
      }
  }
  for (const revision of assessed.keys())
    if (!rootOf(revision)) notes.add("incomplete ancestry in gate assessment history");
  const at = assessed.get(child);
  if (!at) notes.add("no dated assessment of the child on the frozen gate set");
  const priorChildren = [...assessed]
    .filter(
      ([revision, first]) =>
        revision !== child &&
        nodes.get(revision)?.parents.size &&
        root &&
        rootOf(revision) === root &&
        at &&
        (first.time < at.time || (first.time === at.time && compare(first.job, at.job) < 0)),
    )
    .sort((a, b) => a[1].time - b[1].time || compare(a[1].job, b[1].job))
    .map(([revision]) => revision);
  const round = priorChildren.length + 1;
  const alpha = alphaAt(round, policy.alpha);
  add(
    "global",
    "lineage",
    notes.size ? "insufficient" : "pass",
    notes.size
      ? [...notes].sort().join("; ")
      : "complete lineage and dated assessment history supplied",
  );
  const baseParent = nodes.get(parent)?.revision;
  const baseChild = nodes.get(child)?.revision;
  const declarations = [
    {
      set: "gate",
      dataset: policy.gate,
      margin: 0,
      required: true,
      agent: undefined as string | undefined,
    },
    ...policy.guard.map((dataset, i) => ({
      set: `guard:${i}`,
      dataset,
      margin: dataset.margin,
      required: true,
      agent: undefined as string | undefined,
    })),
    ...policy.final.flatMap((dataset, i) =>
      dataset.agents.map((agent) => ({
        set: `final:${i}:${agent}`,
        dataset,
        margin: 0,
        required: false,
        agent,
      })),
    ),
  ];
  if (evidence.selections.some((s) => !declarations.some((d) => d.set === s.set)))
    add("global", "reports", "insufficient", "selection names a set outside the frozen policy");
  const resolve = (ref: GateReportRef) => {
    const job = jobs.get(ref.job);
    const report = reports.get(key(ref.job, ref.revision));
    const method = report?.methods.find((m) => m.method === ref.method);
    const revision = job?.revisions[ref.method];
    return job && report && method && revision ? { job, report, method, revision } : null;
  };
  const sameBasis = (a: MethodRevision, b: MethodRevision) => {
    const { bundleDigest: _a, ...x } = a.basis;
    const { bundleDigest: _b, ...y } = b.basis;
    return (
      !a.approximate &&
      !b.approximate &&
      Boolean(
        /^[a-f0-9]{64}$/.test(a.basis.bundleDigest ?? "") &&
          /^[a-f0-9]{64}$/.test(b.basis.bundleDigest ?? "") &&
          a.basis.bundleDigest !== b.basis.bundleDigest &&
          a.basis.cliVersion &&
          a.basis.cliVersion !== "unknown" &&
          b.basis.cliVersion &&
          b.basis.cliVersion !== "unknown" &&
          a.basis.authKind &&
          b.basis.authKind &&
          a.basis.model &&
          b.basis.model,
      ) &&
      contentDigest(x) === contentDigest(y)
    );
  };
  const matrix = (j: BenchJob, method: ReportMethod): boolean => {
    const expected = j.spec.samplePlan
      ? j.spec.samplePlan.items.map((s) => ({
          key: s.sampleId,
          task: s.taskId,
          sampleRef: s.sampleId,
        }))
      : j.spec.tasks.flatMap((task) =>
          Array.from({ length: j.spec.seeds ?? 1 }, (_, i) => ({
            key: `${task}#${i + 1}`,
            task,
            seed: i + 1,
          })),
        );
    const entries = new Map(method.entries.map((e) => [e.sample, e]));
    return (
      entries.size === method.entries.length &&
      new Set(method.entries.map((e) => e.trial)).size === method.entries.length &&
      entries.size === expected.length &&
      method.planned === expected.length &&
      expected.every((e) => {
        const actual = entries.get(e.key);
        return actual?.task === e.task && sampleKey(actual) === e.key;
      })
    );
  };
  const condition = (j: BenchJob) =>
    contentDigest({
      evaluation: evaluationConditions(j, j.spec.tasks),
      metrics: resolveMetrics(j.metrics),
      seeds: j.spec.seeds,
      samplePlan: j.spec.samplePlan ?? null,
      bindings: j.resolvedBindings ?? null,
      checkpoint: j.spec.checkpoint ?? null,
    });
  const costs = (
    m: ReportMethod,
    eligible: Set<string>,
    metric: "wall" | "tokens",
  ): number | null => {
    if (!m.costs?.length || new Set(m.costs.map((c) => c.run)).size !== m.costs.length) return null;
    const referenced = new Map(m.costs.map((c) => [c.run, c]));
    const declaredTasks = new Set(m.entries.map((e) => e.task));
    if (m.costs.some((c) => !c.complete || c.tasks.some((t) => !declaredTasks.has(t)))) return null;
    if (
      m.entries.some(
        (e) =>
          eligible.has(e.task) &&
          (!e.solveRunId || !referenced.get(e.solveRunId)?.tasks.includes(e.task)),
      )
    )
      return null;
    let total = 0;
    let used = 0;
    for (const row of m.costs) {
      if (!row.tasks.some((t) => eligible.has(t))) continue;
      if (row.tasks.some((t) => !eligible.has(t))) return null;
      const value =
        metric === "wall"
          ? row.wallSeconds
          : row.tokens?.input != null && row.tokens.output != null
            ? row.tokens.input + row.tokens.output
            : null;
      if (value === null || !Number.isFinite(value) || value < 0) return null;
      total += value;
      used++;
    }
    return used && Number.isFinite(total) ? total : null;
  };
  for (const { set, dataset, margin, required, agent } of declarations) {
    const selection = evidence.selections.find((s) => s.set === set);
    const snapshot = evidence.taskSets.find((t) => t.file === dataset.tasks.file);
    let ids: string[] = [];
    try {
      if (
        snapshot &&
        createHash("sha256").update(snapshot.content).digest("hex") === dataset.tasks.sha256
      )
        ids = parseTaskFile(snapshot.content);
    } catch {
      /* Invalid snapshots remain insufficient evidence. */
    }
    const localLearned = [...learned];
    if (agent && selection) {
      const chosen = resolve(selection.child);
      const previous = resolve(selection.parent);
      const problems = new Set<string>();
      const seen = new Set<string>();
      const walk = (revision: string, path = new Set<string>()) => {
        if (path.has(revision)) {
          problems.add("cycle in final-Agent lineage");
          return;
        }
        if (seen.has(revision)) return;
        seen.add(revision);
        const node = nodes.get(revision);
        if (!node || node.parents.size > 1) {
          problems.add("incomplete final-Agent lineage");
          return;
        }
        for (const trial of node.informed) {
          const task = trialTasks.get(trial);
          if (task) localLearned.push({ ...task, trial, revision });
          else problems.add(`missing final-Agent informedBy evidence: ${trial}`);
        }
        for (const p of node.parents) walk(p, new Set([...path, revision]));
      };
      if (chosen) walk(chosen.revision.revision);
      if (
        !chosen ||
        !previous ||
        !nodes.get(chosen.revision.revision)?.parents.has(previous.revision.revision)
      )
        problems.add("final-Agent child must name its selected parent");
      add(
        set,
        "lineage",
        problems.size ? "insufficient" : "pass",
        problems.size
          ? [...problems].sort().join("; ")
          : "final-Agent ancestry included in leakage exclusions",
        false,
      );
    }
    const excluded = localLearned
      .filter((e) => e.benchmark === dataset.benchmark && ids.includes(e.task))
      .map(({ benchmark: _benchmark, ...e }) => e);
    const eligible = new Set(ids.filter((id) => !excluded.some((e) => e.task === id)));
    taskSets.push({
      set,
      benchmark: dataset.benchmark,
      sha256: dataset.tasks.sha256,
      taskSet: setDigest(ids),
      total: ids.length,
      eligible: eligible.size,
      excluded,
    });
    if (!selection || !ids.length) {
      add(
        set,
        "tasks",
        "insufficient",
        !selection
          ? "explicit parent and child report selections required"
          : "task file missing, empty or its SHA-256 differs from policy",
        required,
      );
      continue;
    }
    const a = resolve(selection.parent);
    const b = resolve(selection.child);
    if (!a || !b) {
      add(
        set,
        "reports",
        "insufficient",
        "selected immutable report, job or method revision unavailable",
        required,
      );
      continue;
    }
    const taskOK = [a.job, b.job].every(
      (j) =>
        benchmark(j) === dataset.benchmark &&
        j.taskFile?.sha256 === dataset.tasks.sha256 &&
        j.taskSet === setDigest(ids) &&
        setDigest(j.spec.tasks) === setDigest(ids) &&
        new Set(j.spec.tasks).size === ids.length,
    );
    add(
      set,
      "tasks",
      taskOK ? "pass" : "insufficient",
      taskOK
        ? "frozen task file and job task sets match"
        : "benchmark or submitted task-set digest differs from policy",
      required,
    );
    const reportsOK = [a, b].every(
      (x) =>
        x.report.planDigest === planDigest(x.job) &&
        contentDigest(x.report.official) === contentDigest(x.job.official ?? null) &&
        x.report.metric === policy.metric &&
        x.report.aggregator === (x.job.spec.samplePlan ? "orbit-report/2" : REPORT_AGGREGATOR) &&
        matrix(x.job, x.method),
    );
    add(
      set,
      "reports",
      reportsOK ? "pass" : "insufficient",
      reportsOK
        ? "selected report revisions cover their planned samples"
        : "report plan, metric, aggregator or sample matrix is incompatible",
      required,
    );
    const revisionsOK = agent
      ? a.revision.basis.agent === agent &&
        b.revision.basis.agent === agent &&
        a.revision.basis.bundleDigest === baseParent?.basis.bundleDigest &&
        b.revision.basis.bundleDigest === baseChild?.basis.bundleDigest
      : a.revision.revision === parent && b.revision.revision === child;
    const methodsOK = [a, b].every((x) => {
      const declared = x.job.spec.methods.find((m) => m.name === x.method.method);
      return (
        declared?.agent === x.revision.basis.agent &&
        (declared.model === undefined || declared.model === x.revision.basis.model) &&
        (declared.effort ?? null) === x.revision.basis.effort
      );
    });
    const conditionsOK =
      revisionsOK &&
      methodsOK &&
      sameBasis(a.revision, b.revision) &&
      condition(a.job) === condition(b.job) &&
      [a.job, b.job].every((j) =>
        Boolean(
          j.benchmarkSnapshot && !j.source?.dirty && (j.source?.commit || identity(j)?.version),
        ),
      );
    add(
      set,
      "conditions",
      conditionsOK ? "pass" : "insufficient",
      conditionsOK
        ? "only the configuration bundle differs"
        : "parent results are stale or incomplete; rerun the parent with matching Agent, model, CLI and benchmark conditions",
      required,
    );
    if (!taskOK || !reportsOK || !conditionsOK) continue;
    const metric = resolveMetrics(a.job.metrics).find((m) => m.name === policy.metric);
    if (!metric) {
      add(set, "conditions", "insufficient", "metric is not declared", required);
      continue;
    }
    const left = new Map(
      a.method.entries.filter((e) => eligible.has(e.task)).map((e) => [e.sample, e]),
    );
    const right = new Map(
      b.method.entries.filter((e) => eligible.has(e.task)).map((e) => [e.sample, e]),
    );
    const usable = (e: Entry) =>
      e.evaluation === "valid" && e.value !== null && Number.isFinite(e.value);
    const pairs = new Map<string, { a: number[]; b: number[] }>();
    for (const [sample, x] of left) {
      const y = right.get(sample);
      if (!y || !usable(x) || !usable(y)) continue;
      const row = pairs.get(x.task) ?? { a: [], b: [] };
      row.a.push(x.value as number);
      row.b.push(y.value as number);
      pairs.set(x.task, row);
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const x = new Map([...pairs].map(([t, v]) => [t, { mean: mean(v.a) }]));
    const y = new Map([...pairs].map(([t, v]) => [t, { mean: mean(v.b) }]));
    const diff = metric.higherIsBetter ? pairedDiff(x, y) : pairedDiff(y, x);
    const coverage = eligible.size ? pairs.size / eligible.size : 0;
    const coverageOK = pairs.size >= policy.min_paired_tasks && coverage >= policy.min_coverage;
    add(
      set,
      "coverage",
      coverageOK ? "pass" : "insufficient",
      `${pairs.size}/${eligible.size} eligible tasks paired; minimum ${policy.min_paired_tasks}, coverage ${policy.min_coverage}`,
      required,
      true,
      { parent: pairs.size, child: coverage, limit: policy.min_coverage },
    );
    const invalid = (entries: Map<string, Entry>) =>
      entries.size ? [...entries.values()].filter((e) => !usable(e)).length / entries.size : 1;
    const invalidA = invalid(left);
    const invalidB = invalid(right);
    const valid = invalidB - invalidA <= policy.max_invalid_increase + 1e-12;
    add(
      set,
      "validity",
      valid ? "pass" : "insufficient",
      "unusable sample rates include invalid, unknown, pending and missing metric values",
      required,
      true,
      { parent: invalidA, child: invalidB, limit: policy.max_invalid_increase },
    );
    const lower = lowerBound(diff, alpha);
    const upper = upperBound(diff, alpha);
    const result = set.startsWith("guard:")
      ? nonInferior(diff, margin, alpha)
      : lower !== null && lower > 0
        ? "pass"
        : upper !== null && upper < 0
          ? "fail"
          : "insufficient";
    let exact: GateCheck["mcnemar"];
    if (
      metric.range &&
      [...pairs.values()].every((p) =>
        [mean(p.a), mean(p.b)].every((v) => metric.range?.includes(v)),
      )
    ) {
      let gains = 0;
      let losses = 0;
      for (const p of pairs.values()) {
        const change = (mean(p.b) - mean(p.a)) * (metric.higherIsBetter ? 1 : -1);
        if (change > 0) gains++;
        if (change < 0) losses++;
      }
      const p = mcnemarExact(gains, losses);
      exact = {
        gains,
        losses,
        greater: Number.isFinite(p.greater) ? p.greater : null,
        less: Number.isFinite(p.less) ? p.less : null,
        twoSided: Number.isFinite(p.twoSided) ? p.twoSided : null,
      };
    }
    add(
      set,
      set.startsWith("guard:") ? "non-inferiority" : "improvement",
      result,
      `one-sided paired t bounds; margin ${margin}; McNemar is diagnostic only`,
      required,
      false,
      { diff, lower, upper, limit: -margin, ...(exact ? { mcnemar: exact } : {}) },
    );
    const threshold =
      policy.pass_value ?? (metric.higherIsBetter ? metric.range?.[1] : metric.range?.[0]);
    if (threshold !== undefined)
      for (const [task, px] of x) {
        const cy = y.get(task);
        if (
          cy &&
          (metric.higherIsBetter
            ? px.mean >= threshold && cy.mean < threshold
            : px.mean <= threshold && cy.mean > threshold)
        )
          regressions.push({
            set,
            benchmark: dataset.benchmark,
            task,
            parent: px.mean,
            child: cy.mean,
          });
      }
    for (const name of ["wall", "tokens"] as const) {
      const parentCost = costs(a.method, eligible, name);
      const childCost = costs(b.method, eligible, name);
      const limit = name === "wall" ? policy.cost.max_wall_ratio : policy.cost.max_token_ratio;
      const ratio =
        parentCost === null || childCost === null
          ? null
          : parentCost === 0
            ? childCost === 0
              ? 1
              : null
            : childCost / parentCost;
      add(
        set,
        name === "wall" ? "wall-cost" : "token-cost",
        parentCost === null || childCost === null
          ? "not_checked"
          : parentCost === 0 && childCost > 0
            ? "fail"
            : ratio !== null && ratio <= limit
              ? "pass"
              : "fail",
        parentCost === null || childCost === null
          ? "complete immutable solve-cost records unavailable or a shared Run crosses excluded tasks"
          : "ratio over distinct solve attempts, including failed retries",
        required,
        false,
        { parent: parentCost, child: childCost, limit },
      );
    }
  }
  const required = checks.filter((c) => c.required);
  const decision = required.some((c) => c.prerequisite && c.status !== "pass")
    ? "insufficient"
    : required.some((c) => c.status === "fail")
      ? "reject"
      : required.every((c) => c.status === "pass")
        ? "accept"
        : "insufficient";
  const optional = checks.filter((c) => !c.required);
  const transferred =
    policy.final.length > 0 &&
    policy.final.some((f) => f.agents.some((a) => a !== baseChild?.basis.agent)) &&
    optional.length > 0 &&
    optional.every((c) => c.status === "pass");
  const refs = new Map(
    evidence.reports.flatMap((r) =>
      r.methods.map((m) => {
        const ref = { job: r.jobId, revision: r.revision, method: m.method };
        return [JSON.stringify(ref), ref] as const;
      }),
    ),
  );
  return GateVerdict.parse({
    decision,
    level:
      decision === "accept"
        ? transferred
          ? "transferable"
          : policy.guard.length
            ? "cross-domain"
            : "in-domain"
        : null,
    checks,
    regressions: regressions.sort((a, b) => compare(a.set, b.set) || compare(a.task, b.task)),
    alpha: { round, level: alpha },
    inputs: {
      parent,
      child,
      policyDigest: contentDigest(policy),
      reports: [...refs].sort(([a], [b]) => compare(a, b)).map(([, r]) => r),
      taskSets,
      priorChildren,
    },
  });
}
