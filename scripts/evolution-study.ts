/** Prospective V4 plans and read-only analysis; execution stays in Orbit Run/bench. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gate, gateBenchmark } from "../packages/orbit/src/bench/gate.ts";
import { contentDigest } from "../packages/orbit/src/bench/samples.ts";
import {
  evaluationConditions,
  planDigest,
  reportRunCost,
} from "../packages/orbit/src/bench/summary.ts";
import { fileSha256, taskSetDigest } from "../packages/orbit/src/bench/task-sets.ts";
import {
  BenchJob,
  BenchReport,
  GatePolicy,
  GateRecord,
  type GateReportRef,
  isTerminal,
  MethodRevision,
  parseTaskFile,
  Run,
} from "../packages/orbit/src/contracts/index.ts";
import { aggregate, pairedDiff, resolveMetrics } from "../packages/orbit/src/contracts/metrics.ts";
import { type FrozenSplit, validateSplit } from "./evolution-pilot.ts";

type Arm = "target-only" | "guarded";
export interface StudyPlan {
  version: 1;
  scope: "preview" | "comparison";
  history: "shared-family" | "separate-homes";
  initial: MethodRevision;
  rounds: number;
  chains: { id: string; arm: Arm }[];
  policy: GatePolicy;
  taskFiles: { file: string; content: string }[];
  splits: FrozenSplit[];
  conditions: BenchJob[];
  editor: {
    implementationSha256: string;
    model: string;
    effort: string;
    changedLines: number;
    changedBytes: number;
    tokens: number;
  };
  budget: { tokens: number; perChainTokens: number; finalReserveTokens: number };
}
export interface FrozenStudy {
  frozenAt: string;
  digest: string;
  plan: StudyPlan;
}
export interface StudyRound {
  chain: string;
  round: number;
  editorRun: string;
  editorConfiguration: StudyPlan["editor"];
  changes: { lines: number; bytes: number } | null;
  parent: string;
  candidate: MethodRevision | null;
  informedBy: string[];
  gate: GateRecord | null;
  stop: "editor-failed" | "smoke-failed" | "no-change" | "budget" | null;
}
export interface StudyEvidence {
  planDigest: string;
  rounds: StudyRound[];
  closed: {
    chain: string;
    endedAt: string;
    reason: "rounds-complete" | "budget" | "editor-failed" | "smoke-failed" | "no-change";
  }[];
  jobs: BenchJob[];
  reports: BenchReport[];
  /** All newly submitted model Runs, including failed/invalid/retried attempts. */
  runs: Run[];
  /** Explicit attribution; shared runs are charged once, never once per referencing cell. */
  allocation: { run: string; owner: string }[];
  finals: {
    chain: string;
    dataset: number;
    parent: GateReportRef | null;
    child: GateReportRef | null;
    notRun?: string;
  }[];
}
const same = (a: unknown, b: unknown) => contentDigest(a) === contentDigest(b);
const time = (v: string) => {
  const t = Date.parse(v);
  assert(Number.isFinite(t), "invalid timestamp");
  return t;
};
const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
const unique = (ids: string[], label: string) =>
  assert(new Set(ids).size === ids.length, `duplicate ${label}`);
const refKey = (r: GateReportRef) => JSON.stringify([r.job, r.revision, r.method]);
function basis(revision: MethodRevision) {
  revision = MethodRevision.parse(revision);
  assert(
    !revision.approximate && contentDigest(revision.basis).slice(7, 19) === revision.revision,
    "inexact method revision",
  );
  const { bundleDigest, ...rest } = revision.basis;
  assert(bundleDigest && /^[a-f0-9]{64}$/.test(bundleDigest), "bundle digest required");
  return rest;
}
function tasks(plan: StudyPlan, dataset: GatePolicy["gate"]) {
  const file = plan.taskFiles.find((f) => f.file === dataset.tasks.file);
  assert(file && fileSha256(file.content) === dataset.tasks.sha256, "changed task file");
  return parseTaskFile(file.content);
}
function condition(job: BenchJob, ids: string[]) {
  return {
    evaluation: evaluationConditions(job, ids),
    metrics: resolveMetrics(job.metrics),
    seeds: job.spec.seeds,
    bindings: job.resolvedBindings ?? null,
    checkpoint: job.spec.checkpoint ?? null,
  };
}
export function validateStudy(plan: StudyPlan) {
  assert(plan.version === 1 && ["preview", "comparison"].includes(plan.scope), "unsupported study");
  assert(["shared-family", "separate-homes"].includes(plan.history), "invalid history scope");
  assert(
    plan.scope === "preview" || plan.history === "separate-homes",
    "comparisons require separate chain homes",
  );
  assert(positive(plan.rounds), "positive round limit required");
  unique(
    plan.chains.map((c) => c.id),
    "chain",
  );
  assert(
    plan.chains.every(
      (c) => /^[a-z0-9-]+$/.test(c.id) && ["target-only", "guarded"].includes(c.arm),
    ),
    "invalid chain",
  );
  const counts = ["target-only", "guarded"].map(
    (arm) => plan.chains.filter((c) => c.arm === arm).length,
  );
  assert(
    counts[0] && counts[0] >= 2 && counts[0] === counts[1],
    "two balanced arms with at least two chains each required",
  );
  assert(basis(plan.initial).agent === "codex", "this study helper currently supports Codex only");
  plan.policy = GatePolicy.parse(plan.policy);
  assert(
    plan.policy.guard.some((d) => d.benchmark !== plan.policy.gate.benchmark),
    "a cross-environment guard is required",
  );
  assert(
    new Set(plan.policy.final.map((d) => d.benchmark)).size >= 2 &&
      plan.policy.final.every((d) => d.benchmark !== plan.policy.gate.benchmark),
    "two distinct held-out final families are required",
  );
  assert(
    plan.policy.guard.length && plan.policy.final.length >= 2,
    "guard and at least two final datasets required",
  );
  assert(
    plan.policy.final.every((d) => same(d.agents, [plan.initial.basis.agent])),
    "second-Agent studies require a new frozen plan and implementation",
  );
  unique(
    plan.taskFiles.map((f) => f.file),
    "task file",
  );
  unique(
    plan.splits.map((s) => s.manifest.benchmark.identity.id),
    "split benchmark",
  );
  unique(plan.conditions.map(gateBenchmark), "condition benchmark");
  for (const split of plan.splits) validateSplit(split);
  const used = new Set<string>();
  for (const [role, datasets] of [
    ["gate", [plan.policy.gate, ...plan.policy.guard]],
    ["final", plan.policy.final],
  ] as const) {
    for (const dataset of datasets) {
      const ids = tasks(plan, dataset);
      const split = plan.splits.find((s) => s.manifest.benchmark.identity.id === dataset.benchmark);
      const template = plan.conditions.find((j) => gateBenchmark(j) === dataset.benchmark);
      assert(split && template, "split and frozen conditions required for each dataset");
      const { selected } = validateSplit(split);
      assert(
        ids.every((id) => selected[role].has(id)),
        `tasks outside frozen ${role} partition`,
      );
      for (const id of ids) {
        const key = JSON.stringify([dataset.benchmark, id]);
        assert(!used.has(key), "study datasets overlap");
        used.add(key);
      }
      assert(
        template.source?.commit === split.manifest.benchmark.source?.commit &&
          template.source?.dirty === split.manifest.benchmark.source?.dirty,
        "split source differs from conditions",
      );
      assert(
        !template.spec.samplePlan && !template.spec.batchSize,
        "batched/sample-plan studies are not supported",
      );
      assert(template.spec.seeds >= 1, "seeds required");
      if (plan.scope === "comparison" && role === "gate")
        assert(
          ids.length >= plan.policy.min_paired_tasks,
          "comparison admission set below minimum",
        );
    }
  }
  const e = plan.editor,
    b = plan.budget;
  assert(
    /^[a-f0-9]{64}$/.test(e.implementationSha256) &&
      e.model &&
      e.effort &&
      [e.changedLines, e.changedBytes, e.tokens].every(positive),
    "invalid editor freeze",
  );
  assert([b.tokens, b.perChainTokens, b.finalReserveTokens].every(positive), "invalid budget");
  assert(
    b.perChainTokens * plan.chains.length + b.finalReserveTokens <= b.tokens,
    "chain budgets consume final reserve",
  );
  return plan;
}
export function freezeStudy(plan: StudyPlan, frozenAt = new Date().toISOString()): FrozenStudy {
  plan = validateStudy(structuredClone(plan));
  for (const dataset of [plan.policy.gate, ...plan.policy.guard, ...plan.policy.final]) {
    const template = plan.conditions.find((j) => gateBenchmark(j) === dataset.benchmark);
    assert(
      template &&
        (template.resources === null ||
          tasks(plan, dataset).every((id) => id in (template.resources ?? {}))),
      "condition template lacks selected task resource overrides; resolve them before freezing",
    );
  }
  time(frozenAt);
  return { frozenAt, digest: contentDigest({ frozenAt, plan }), plan };
}
function frozen(study: FrozenStudy) {
  assert(
    study.digest === contentDigest({ frozenAt: study.frozenAt, plan: study.plan }),
    "frozen study changed",
  );
  time(study.frozenAt);
  return validateStudy(structuredClone(study.plan));
}
export function admissionPolicy(plan: StudyPlan, arm: Arm) {
  return GatePolicy.parse({
    ...plan.policy,
    guard: arm === "guarded" ? plan.policy.guard : [],
    final: [],
  });
}

/** Reservations are prospective estimates, not a model-call hard token interrupt. */
export function studyBudget(
  study: FrozenStudy,
  snapshots: Run[],
  nextTokens = 0,
  reserveFinal = true,
) {
  const plan = frozen(study);
  assert(Number.isSafeInteger(nextTokens) && nextTokens >= 0, "invalid reservation");
  const runs = snapshots.map((r) => Run.parse(r));
  unique(
    runs.map((r) => r.id),
    "Run snapshot",
  );
  let knownTokens = 0;
  const unknown: string[] = [];
  for (const run of runs) {
    assert(time(run.createdAt) >= time(study.frozenAt), "pre-study Run in new budget");
    if (
      !isTerminal(run.state) ||
      run.cleanup !== "done" ||
      run.tokens?.input == null ||
      run.tokens.output == null
    )
      unknown.push(run.id);
    else knownTokens += run.tokens.input + run.tokens.output;
  }
  const reserved = nextTokens + (reserveFinal ? plan.budget.finalReserveTokens : 0);
  return {
    knownTokens,
    unknown,
    totalTokens: unknown.length ? null : knownTokens,
    reserved,
    limit: plan.budget.tokens,
    canSubmit: !unknown.length && knownTokens + reserved <= plan.budget.tokens,
  };
}

export function summarizeStudy(study: FrozenStudy, input: StudyEvidence) {
  const plan = frozen(study);
  assert(input.planDigest === study.digest, "evidence names a different plan");
  const jobs = input.jobs.map((j) => BenchJob.parse(j));
  const reports = input.reports.map((r) => BenchReport.parse(r));
  const runs = input.runs.map((r) => Run.parse(r));
  unique(
    jobs.map((j) => j.id),
    "job",
  );
  unique(
    reports.map((r) => `${r.jobId}@${r.revision}`),
    "report",
  );
  unique(
    input.rounds.map((r) => r.editorRun),
    "editor Run across chains",
  );
  if (plan.history === "separate-homes") {
    const owners = new Map<string, string>();
    for (const round of input.rounds)
      for (const selection of round.gate?.evidence.selections ?? []) {
        const ref = selection.child;
        const report = round.gate?.evidence.reports.find(
          (r) => r.jobId === ref.job && r.revision === ref.revision,
        );
        const method = report?.methods.find((m) => m.method === ref.method);
        for (const key of [refKey(ref), ...(method?.costs ?? []).map((c) => c.run)]) {
          assert(
            !owners.has(key) || owners.get(key) === round.chain,
            "candidate assessment reused across independent chains",
          );
          owners.set(key, round.chain);
        }
      }
  }
  unique(
    input.closed.map((c) => c.chain),
    "closed chain",
  );
  unique(
    input.allocation.map((a) => a.run),
    "cost allocation",
  );
  assert(
    input.allocation.length === runs.length &&
      input.allocation.every(
        (a) =>
          runs.some((r) => r.id === a.run) &&
          ["shared", "final", ...plan.chains.map((c) => c.id)].includes(a.owner),
      ),
    "every new model Run needs exactly one allocation",
  );
  const runMap = new Map(runs.map((r) => [r.id, r]));
  const resolveRef = (ref: GateReportRef) => {
    const job = jobs.find((j) => j.id === ref.job),
      report = reports.find((r) => r.jobId === ref.job && r.revision === ref.revision);
    const method = report?.methods.find((m) => m.method === ref.method),
      revision = job?.revisions[ref.method];
    assert(job && report && method && revision, "selected report unavailable");
    return { job, report, method, revision };
  };
  const checkJob = (job: BenchJob, allowIncompatible = false) => {
    const template = plan.conditions.find((j) => gateBenchmark(j) === gateBenchmark(job));
    const compatible = Boolean(
      template && same(condition(job, job.spec.tasks), condition(template, job.spec.tasks)),
    );
    assert(compatible || allowIncompatible, "evaluation conditions changed");
    assert(
      !job.spec.samplePlan && !job.spec.batchSize && job.state !== "running",
      "finished unbatched jobs required",
    );
    for (const revision of Object.values(job.revisions))
      assert(same(basis(revision), basis(plan.initial)), "method conditions changed");
    return compatible;
  };
  for (const job of jobs)
    if (time(job.createdAt) >= time(study.frozenAt)) {
      assert(
        job.state !== "running" && reports.some((r) => r.jobId === job.id),
        "new job missing finished report",
      );
    }
  // Costs cover all solve attempts in every supplied report, regardless of validity or admission.
  for (const report of reports) {
    const job = jobs.find((j) => j.id === report.jobId);
    assert(job, "report job missing");
    if (time(job.createdAt) < time(study.frozenAt)) continue;
    for (const method of report.methods) {
      assert(
        method.costs &&
          method.entries.every(
            (e) => !e.solveRunId || method.costs?.some((c) => c.run === e.solveRunId),
          ),
        "report attempt costs missing",
      );
      for (const cost of method.costs)
        assert(runMap.has(cost.run), "new solve attempt missing from budget");
    }
  }
  const chains = plan.chains.map((chain) => {
    let endpoint = plan.initial.revision;
    let ended = time(study.frozenAt);
    const assessed: string[] = [];
    const rounds = input.rounds
      .filter((r) => r.chain === chain.id)
      .sort((a, b) => a.round - b.round);
    const close = input.closed.find((c) => c.chain === chain.id);
    assert(close && rounds.length <= plan.rounds, "chain not closed or round limit exceeded");
    const decisions = { accept: 0, reject: 0, insufficient: 0, stopped: 0 };
    const alphas: number[] = [];
    for (const [i, round] of rounds.entries()) {
      assert(
        round.round === i + 1 && round.parent === endpoint,
        "chain must advance only after acceptance",
      );
      assert(same(round.editorConfiguration, plan.editor), "editor configuration changed");
      const editor = runMap.get(round.editorRun);
      assert(
        editor &&
          time(editor.createdAt) >= ended &&
          editor.endedAt &&
          isTerminal(editor.state) &&
          editor.cleanup === "done",
        "editor chronology or cleanup invalid",
      );
      assert(
        input.allocation.find((a) => a.run === editor.id)?.owner === chain.id,
        "editor allocated to wrong chain",
      );
      assert(
        editor.spec.backend === "docker" &&
          !editor.spec.hostNetwork &&
          !editor.spec.project &&
          !editor.spec.root &&
          !editor.spec.agentBundle &&
          editor.spec.mounts.length === 1 &&
          editor.spec.mounts[0]?.mode === "ro" &&
          editor.spec.mounts[0]?.target === "/evolve-input",
        "editor isolation differs from V3",
      );
      assert(round.informedBy.length, "editor input provenance required");
      for (const trial of round.informedBy) {
        const found = reports.flatMap((r) =>
          r.methods.flatMap((m) =>
            m.entries.filter((e) => e.trial === trial).map((e) => ({ r, m, e })),
          ),
        );
        assert(found.length, "informedBy report missing");
        for (const { r, m, e } of found) {
          const job = jobs.find((j) => j.id === r.jobId);
          const split = plan.splits.find(
            (s) => s.manifest.benchmark.identity.id === (job && gateBenchmark(job)),
          );
          assert(
            job &&
              split &&
              job.revisions[m.method]?.revision === round.parent &&
              time(r.createdAt) <= time(editor.createdAt) &&
              validateSplit(split).selected.evolve.has(e.task) &&
              e.evaluation === "valid",
            "editor learned outside evolve partition",
          );
        }
      }
      ended = time(editor.endedAt);
      if (!round.gate) {
        assert(
          round.stop && i === rounds.length - 1 && close.reason === round.stop,
          "stopped round must close its chain",
        );
        decisions.stopped++;
        continue;
      }
      assert(
        !round.stop &&
          round.candidate &&
          editor.state === "succeeded" &&
          editor.tokens?.input != null &&
          editor.tokens.output != null &&
          editor.tokens.input + editor.tokens.output <= plan.editor.tokens,
        "unusable editor candidate",
      );
      assert(
        round.changes &&
          Number.isSafeInteger(round.changes.lines) &&
          Number.isSafeInteger(round.changes.bytes) &&
          round.changes.lines >= 0 &&
          round.changes.bytes >= 0 &&
          round.changes.lines <= plan.editor.changedLines &&
          round.changes.bytes <= plan.editor.changedBytes,
        "candidate change budget exceeded",
      );
      assert(same(basis(round.candidate), basis(plan.initial)), "candidate conditions changed");
      const record = GateRecord.parse(round.gate),
        verdict = gate(
          record.verdict.inputs.parent,
          record.verdict.inputs.child,
          record.policy,
          record.evidence,
          record.mode,
        );
      assert(
        record.mode === "promotion" && same(record.verdict, verdict),
        "saved verdict differs from evidence",
      );
      assert(same(record.policy, admissionPolicy(plan, chain.arm)), "admission policy changed");
      assert(
        verdict.inputs.parent === endpoint && verdict.inputs.child === round.candidate.revision,
        "wrong gate lineage",
      );
      assert(time(record.createdAt) >= ended, "gate preceded editor");
      ended = time(record.createdAt);
      if (plan.history === "separate-homes")
        assert(
          same([...verdict.inputs.priorChildren].sort(), [...assessed].sort()),
          "assessment history crosses chains or omits prior rounds",
        );
      assessed.push(round.candidate.revision);
      alphas.push(verdict.alpha.level);
      assert(
        verdict.checks
          .filter((c) => c.set === "global" && c.kind === "lineage")
          .every((c) => c.status === "pass"),
        "invalid lineage evidence",
      );
      for (const ref of record.evidence.selections.flatMap((s) => [s.parent, s.child])) {
        const selected = resolveRef(ref);
        checkJob(selected.job);
        assert(
          time(selected.job.createdAt) < time(record.createdAt) &&
            time(selected.report.createdAt) <= time(record.createdAt),
          "admission evidence created after verdict",
        );
        assert(
          same(
            selected.job,
            record.evidence.jobs.find((j) => j.id === ref.job),
          ) &&
            same(
              selected.report,
              record.evidence.reports.find(
                (r) => r.jobId === ref.job && r.revision === ref.revision,
              ),
            ),
          "gate evidence snapshot changed",
        );
        const set = record.evidence.selections.find(
          (s) => refKey(s.parent) === refKey(ref) || refKey(s.child) === refKey(ref),
        );
        assert(set && !set.set.startsWith("final"), "final used for admission");
      }
      assert(
        verdict.inputs.taskSets.every((s) => !s.excluded.length),
        "held-out data used for learning",
      );
      const informed = new Set(
        record.evidence.jobs.flatMap((j) =>
          Object.entries(j.revisions)
            .filter(([, r]) => r.revision === round.candidate?.revision)
            .flatMap(([m]) => j.spec.lineage[m]?.informedBy ?? []),
        ),
      );
      assert(
        round.informedBy.length && same([...informed].sort(), [...round.informedBy].sort()),
        "editor provenance differs from lineage",
      );
      decisions[verdict.decision]++;
      if (verdict.decision === "accept") endpoint = round.candidate.revision;
    }
    assert(
      time(close.endedAt) >= ended &&
        (close.reason !== "rounds-complete" || rounds.length === plan.rounds),
      "chain closed prematurely",
    );
    return {
      ...chain,
      endpoint,
      roundsAttempted: rounds.length,
      decisions,
      alphas,
      endedAt: close.endedAt,
      reason: close.reason,
    };
  });
  assert(
    input.rounds.every((r) => plan.chains.some((c) => c.id === r.chain)) &&
      input.closed.length === chains.length,
    "unknown chain",
  );
  const allClosed = Math.max(...chains.map((c) => time(c.endedAt)));
  for (const dataset of plan.policy.final) {
    const heldOut = new Set(tasks(plan, dataset));
    assert(
      !jobs.some(
        (j) =>
          time(j.createdAt) < allClosed &&
          gateBenchmark(j) === dataset.benchmark &&
          j.spec.tasks.some((t) => heldOut.has(t)),
      ),
      "final tasks were evaluated before chain closure",
    );
  }
  unique(
    input.finals.map((f) => `${f.chain}:${f.dataset}`),
    "final cell",
  );
  assert(
    input.finals.length === chains.length * plan.policy.final.length,
    "final matrix incomplete",
  );
  const cells = input.finals.map((cell) => {
    const chain = chains.find((c) => c.id === cell.chain),
      dataset = plan.policy.final[cell.dataset];
    assert(chain && dataset, "unknown final cell");
    const ids = tasks(plan, dataset);
    if (!cell.parent || !cell.child) {
      assert(
        cell.parent === null && cell.child === null && cell.notRun?.trim(),
        "missing final cell needs an explicit not-run reason",
      );
      return {
        chain: chain.id,
        arm: chain.arm,
        benchmark: dataset.benchmark,
        agent: plan.initial.basis.agent,
        metric: dataset.metric ?? plan.policy.metric,
        initial: plan.initial.revision,
        endpoint: chain.endpoint,
        parent: null,
        child: null,
        status: "not_run" as const,
        reason: cell.notRun,
        reused: false,
        plannedTasks: ids.length,
        pairedTasks: null,
        parentStats: null,
        childStats: null,
        diff: null,
        unchangedBundle: chain.endpoint === plan.initial.revision,
        invalid: null,
        guardFamily: plan.policy.guard.some((g) => g.benchmark === dataset.benchmark),
      };
    }
    assert(!cell.notRun, "measured final cell cannot be marked not-run");
    const sides = [resolveRef(cell.parent), resolveRef(cell.child)];
    let compatible = true;
    for (const [i, side] of sides.entries()) {
      const { job, report, method, revision } = side;
      compatible = checkJob(job, true) && compatible;
      assert(time(job.createdAt) >= allClosed, "final evaluation began before all chains closed");
      assert(
        revision.revision === (i ? chain.endpoint : plan.initial.revision),
        "final revision differs from chain endpoint",
      );
      assert(
        gateBenchmark(job) === dataset.benchmark &&
          job.taskFile?.sha256 === dataset.tasks.sha256 &&
          job.taskSet === taskSetDigest(ids) &&
          same([...job.spec.tasks].sort(), [...ids].sort()),
        "final task set differs",
      );
      assert(
        report.planDigest === planDigest(job) &&
          report.aggregator === "orbit-report/1" &&
          report.metric === (dataset.metric ?? plan.policy.metric) &&
          same(report.official, job.official ?? null),
        "final report incompatible",
      );
      const metric = resolveMetrics(job.metrics).find((m) => m.name === report.metric);
      assert(
        metric &&
          method.entries.every(
            (e) =>
              e.evaluation !== "valid" ||
              (e.value !== null &&
                Number.isFinite(e.value) &&
                (!metric.range || (e.value >= metric.range[0] && e.value <= metric.range[1]))),
          ),
        "invalid final metric values",
      );
      const samples = ids
        .flatMap((task) =>
          Array.from({ length: job.spec.seeds ?? 1 }, (_, s) => `${task}#${s + 1}`),
        )
        .sort();
      unique(
        method.entries.map((e) => e.trial),
        "final trial",
      );
      assert(
        method.planned === samples.length &&
          same(method.entries.map((e) => e.sample).sort(), samples) &&
          method.entries.every((e) => e.sample === `${e.task}#${e.seed}`),
        "final sample matrix differs",
      );
    }
    const a = sides[0],
      b = sides[1];
    assert(a && b);
    const reused = refKey(cell.parent) === refKey(cell.child);
    assert(
      !reused || chain.endpoint === plan.initial.revision,
      "changed endpoint reuses baseline report",
    );
    if (!reused)
      assert(
        !a.method.entries.some((x) =>
          b.method.entries.some(
            (y) => x.trial === y.trial || (x.solveRunId && x.solveRunId === y.solveRunId),
          ),
        ),
        "final attempts reused across different reports",
      );
    const byTask = (entries: typeof a.method.entries) =>
      new Map(
        ids.flatMap((task) => {
          const rows = entries.filter((e) => e.task === task);
          // Match the complete seed set: invalid or missing samples cannot silently change the estimand.
          return rows.length && rows.every((e) => e.evaluation === "valid" && e.value !== null)
            ? [
                [
                  task,
                  {
                    mean: rows.reduce((s, e) => s + (e.value ?? 0), 0) / rows.length,
                    n: rows.length,
                  },
                ] as const,
              ]
            : [];
        }),
      );
    const parentMeans = byTask(a.method.entries),
      childMeans = byTask(b.method.entries);
    const diff = pairedDiff(parentMeans, childMeans);
    return {
      chain: chain.id,
      arm: chain.arm,
      benchmark: dataset.benchmark,
      agent: plan.initial.basis.agent,
      metric: dataset.metric ?? plan.policy.metric,
      initial: plan.initial.revision,
      endpoint: chain.endpoint,
      parent: cell.parent,
      child: cell.child,
      status: !compatible
        ? ("incompatible" as const)
        : diff?.tasks === ids.length
          ? ("measured" as const)
          : ("invalid" as const),
      reason: compatible ? null : "evaluation conditions differ from frozen plan",
      reused,
      plannedTasks: ids.length,
      pairedTasks: compatible ? (diff?.tasks ?? 0) : null,
      parentStats: compatible ? aggregate(parentMeans) : null,
      childStats: compatible ? aggregate(childMeans) : null,
      diff: reused || !compatible ? null : diff,
      unchangedBundle: chain.endpoint === plan.initial.revision,
      invalid: sides.map((s) => s.method.entries.filter((e) => e.evaluation !== "valid").length),
      guardFamily: plan.policy.guard.some((g) => g.benchmark === dataset.benchmark),
    };
  });
  const cost = studyBudget(study, runs, 0, false);
  const owners = ["shared", ...chains.map((c) => c.id), "final"].map((owner) => {
    const own = runs.filter((r) =>
      input.allocation.some((a) => a.run === r.id && a.owner === owner),
    );
    const summary = studyBudget(study, own, 0, false);
    return {
      owner,
      runs: own.length,
      tokens: summary.totalTokens,
      knownTokens: summary.knownTokens,
      withinChainBudget:
        owner === "shared" || owner === "final"
          ? null
          : summary.totalTokens !== null && summary.totalTokens <= plan.budget.perChainTokens,
    };
  });
  return {
    scope: plan.scope,
    comparisonCompleted:
      cells.every((c) => c.status === "measured") &&
      chains.every(
        (c) =>
          c.reason === "rounds-complete" &&
          c.decisions.accept + c.decisions.reject + c.decisions.insufficient === plan.rounds,
      ),
    coverage: {
      plannedChains: chains.length,
      startedChains: chains.filter((c) => c.roundsAttempted > 0).length,
      assessedRounds: chains.reduce(
        (n, c) => n + c.decisions.accept + c.decisions.reject + c.decisions.insufficient,
        0,
      ),
    },
    planDigest: study.digest,
    chains,
    cells,
    costs: {
      ...cost,
      owners,
      wallSecondsKnown: runs.reduce((s, r) => s + (reportRunCost(r).wallSeconds ?? 0), 0),
      wallUnknown: runs.filter((r) => reportRunCost(r).wallSeconds === null).map((r) => r.id),
    },
    limitations: [
      "No aggregate score across benchmarks; intervals are task-clustered, conditional on the selected endpoint, not independent-chain causal inference.",
      "Shared baseline/final reports are reused evidence, not additional independent samples; identical endpoint reuse has no measured difference or interval.",
      "Costs cover the supplied complete run inventory, including failed/invalid/retried model runs; external or omitted calls cannot be inferred.",
      ...(plan.scope === "preview"
        ? ["Workflow preview only; no evolution-effect conclusion."]
        : []),
      ...(plan.history === "shared-family"
        ? [
            "Preview shares family alpha-spending history; a formal comparison requires separate Orbit homes per chain.",
          ]
        : []),
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  try {
    const [command, path, arg, extra] = process.argv.slice(2);
    assert(
      path,
      "usage: evolution-study.ts freeze PLAN OUTPUT | budget FROZEN RUNS [NEXT_TOKENS] | analyze FROZEN EVIDENCE",
    );
    if (command === "freeze") {
      assert(arg && !extra, "output path required");
      const result = freezeStudy(read(path));
      writeFileSync(arg, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify({ digest: result.digest, frozenAt: result.frozenAt }));
    } else {
      assert(arg && ["budget", "analyze"].includes(command ?? ""), "unknown action");
      const result =
        command === "budget"
          ? studyBudget(read(path), read(arg), Number(extra ?? 0))
          : summarizeStudy(read(path), read(arg));
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
