import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { gate } from "../packages/orbit/src/bench/gate.ts";
import { revisionOf } from "../packages/orbit/src/bench/revision.ts";
import { contentDigest } from "../packages/orbit/src/bench/samples.ts";
import { fileSha256, taskSetDigest } from "../packages/orbit/src/bench/task-sets.ts";
import { BenchSplitManifest, GateRecord, Run } from "../packages/orbit/src/contracts/index.ts";
import { child, fixture, parent } from "../packages/orbit/test/fixtures/gate.ts";
import {
  admissionPolicy,
  freezeStudy,
  type StudyEvidence,
  type StudyPlan,
  studyBudget,
  summarizeStudy,
} from "./evolution-study.ts";

const at = (n: number) => `2026-11-14T00:${String(n).padStart(2, "0")}:00Z`;
function run(id: string, created = 10) {
  return Run.parse({
    id,
    spec: { backend: "process", command: ["true"] },
    state: "succeeded",
    cleanup: "done",
    reason: null,
    exitCode: 0,
    node: "fixture",
    image: null,
    containerId: null,
    lease: null,
    code: null,
    note: "",
    createdAt: at(created),
    startedAt: at(created),
    endedAt: at(created + 1),
    tokens: {
      input: 100,
      output: 20,
      cachedInput: 80,
      cacheWrite: 0,
      reasoning: 0,
      calls: 1,
      source: "session",
    },
  });
}
function setup() {
  const f = fixture(2);
  const evolve = f.pair("evolve"),
    guard = f.pair("guard:0", "other"),
    finalA = f.pair("final-a", "other"),
    finalB = f.pair("final-b", "third");
  f.target.b.spec.lineage.candidate = {
    parent: parent.revision,
    informedBy: [evolve.ra.methods[0]?.entries[0]?.trial ?? ""],
  };
  for (const job of [f.target.a, f.target.b, guard.a, guard.b]) {
    job.createdAt = at(13);
    job.endedAt = at(14);
  }
  for (const final of [finalA, finalB]) {
    for (const job of [final.a, final.b]) {
      job.createdAt = at(30);
      job.endedAt = at(31);
    }
  }
  const plan: StudyPlan = {
    version: 1,
    scope: "preview",
    history: "shared-family",
    initial: parent,
    rounds: 1,
    chains: ["a1", "b1", "a2", "b2"].map((id) => ({
      id,
      arm: id[0] === "a" ? "target-only" : "guarded",
    })),
    policy: {
      ...f.policy,
      guard: [{ ...guard.dataset, margin: 5 }],
      final: [finalA, finalB].map((s) => ({ ...s.dataset, agents: ["codex"] })),
    },
    taskFiles: f.evidence.taskSets.filter((s) => s.file !== "evolve.txt"),
    splits: [],
    conditions: [f.target.a, guard.a, finalB.a],
    editor: {
      implementationSha256: "a".repeat(64),
      model: "fixture-model",
      effort: "medium",
      changedLines: 10,
      changedBytes: 4096,
      tokens: 1000,
    },
    budget: { tokens: 100000, perChainTokens: 20000, finalReserveTokens: 10000 },
  };
  for (const benchmark of ["fixture", "other", "third"]) {
    const content = {
      evolve: benchmark === "fixture" ? `${evolve.tasks.join("\n")}\n` : "evolve-unused\n",
      gate: `${(benchmark === "fixture" ? f.target.tasks : benchmark === "other" ? guard.tasks : ["gate-unused"]).join("\n")}\n`,
      final: `${(benchmark === "other" ? finalA.tasks : benchmark === "third" ? finalB.tasks : ["final-unused"]).join("\n")}\n`,
    };
    const all = Object.values(content).flatMap((s) => s.trim().split("\n"));
    plan.splits.push({
      content,
      manifest: BenchSplitManifest.parse({
        version: 1,
        algorithm: "sha256-stratified-v1",
        benchmark: {
          registration: benchmark,
          identity: { id: benchmark, version: "1", variant: null },
          source: { commit: "a".repeat(40), dirty: false },
          settingsSha256: "b".repeat(64),
        },
        seed: 42,
        proportions: { evolve: 0.2, gate: 0.6, final: 0.2 },
        stratify: "suite",
        population: {
          count: all.length,
          taskSet: taskSetDigest(all),
          listingSha256: "c".repeat(64),
        },
        unsupported: 0,
        files: Object.fromEntries(
          Object.entries(content).map(([p, s]) => [
            p,
            {
              path: `${p}.txt`,
              sha256: fileSha256(s),
              taskSet: taskSetDigest(s.trim().split("\n")),
              count: s.trim().split("\n").length,
            },
          ]),
        ),
      }),
    });
  }
  const study = freezeStudy(plan, at(5));
  const evidence: StudyEvidence = {
    planDigest: study.digest,
    jobs: f.evidence.jobs,
    reports: f.evidence.reports,
    rounds: [],
    closed: [],
    runs: [],
    allocation: [],
    finals: [],
  };
  for (const chain of plan.chains) {
    const editor = run(chain.id);
    editor.spec.backend = "docker";
    editor.spec.image = "fixture-image";
    delete editor.spec.project;
    editor.spec.mounts = [{ source: "/fixture/input", target: "/evolve-input", mode: "ro" }];
    evidence.runs.push(editor);
    evidence.allocation.push({ run: editor.id, owner: chain.id });
    evidence.rounds.push({
      chain: chain.id,
      round: 1,
      editorRun: editor.id,
      editorConfiguration: plan.editor,
      changes: { lines: 2, bytes: 50 },
      parent: parent.revision,
      candidate: null,
      informedBy: [evolve.ra.methods[0]?.entries[0]?.trial ?? ""],
      gate: null,
      stop: "no-change",
    });
    evidence.closed.push({ chain: chain.id, endedAt: at(20), reason: "no-change" });
    for (const [dataset, final] of [finalA, finalB].entries()) {
      const ref = { job: final.a.id, revision: 1, method: "candidate" };
      evidence.finals.push({ chain: chain.id, dataset, parent: ref, child: ref });
    }
  }
  for (const report of evidence.reports) {
    const job = evidence.jobs.find((j) => j.id === report.jobId);
    assert(job);
    if (Date.parse(job.createdAt) < Date.parse(study.frozenAt)) continue;
    for (const cost of report.methods.flatMap((m) => m.costs ?? [])) {
      evidence.runs.push(run(cost.run, job.id.startsWith("final") ? 30 : 13));
      evidence.allocation.push({
        run: cost.run,
        owner: job.id.startsWith("final") ? "final" : "shared",
      });
    }
  }
  const gated = () => {
    const round = evidence.rounds[0],
      close = evidence.closed[0];
    assert(round && close);
    const policy = admissionPolicy(study.plan, "target-only");
    const selected = f.evidence.selections.filter((s) => s.set === "gate");
    const ge = {
      ...f.evidence,
      selections: selected,
      taskSets: f.evidence.taskSets.filter((s) => s.file === "gate.txt"),
    };
    round.candidate = child;
    round.informedBy = [...(f.target.b.spec.lineage.candidate?.informedBy ?? [])];
    round.stop = null;
    round.gate = GateRecord.parse({
      id: "saved",
      createdAt: at(15),
      evaluator: "orbit-gate/1",
      mode: "promotion",
      policy,
      evidence: ge,
      verdict: gate(parent.revision, child.revision, policy, ge),
    });
    close.reason = "rounds-complete";
    return round;
  };
  return { f, study, evidence, plan, gated, finalA };
}

it("freezes balanced arms and rejects changed partitions, policy inputs, budgets and insufficient formal plans", () => {
  const { plan } = setup();
  expect(() => freezeStudy({ ...plan, scope: "comparison" })).toThrow("separate chain homes");
  expect(() => freezeStudy({ ...plan, scope: "comparison", history: "separate-homes" })).toThrow(
    "below minimum",
  );
  expect(() => freezeStudy({ ...plan, chains: plan.chains.slice(1) })).toThrow("balanced");
  expect(() => freezeStudy({ ...plan, budget: { ...plan.budget, tokens: 5 } })).toThrow(
    "final reserve",
  );
  const split = plan.splits[0];
  assert(split);
  split.content.final += "leaked\n";
  expect(() => freezeStudy(plan)).toThrow("changed frozen");
});
it("counts cached input once, keeps unknown costs blocking and reserves terminal evaluation", () => {
  const { study } = setup();
  expect(studyBudget(study, [run("r")], 100)).toMatchObject({
    knownTokens: 120,
    reserved: 10100,
    canSubmit: true,
  });
  expect(studyBudget(study, [run("r")], 90000).canSubmit).toBe(false);
  const missing = run("missing");
  missing.tokens = null;
  expect(studyBudget(study, [missing])).toMatchObject({
    totalTokens: null,
    unknown: ["missing"],
    canSubmit: false,
  });
  expect(() => studyBudget(study, [run("r"), run("r")])).toThrow("duplicate");
  study.plan.rounds++;
  expect(() => studyBudget(study, [])).toThrow("frozen study changed");
});
it("retains insufficient candidates and does not invent zero-difference intervals from reused final reports", () => {
  const { study, evidence, gated } = setup();
  gated();
  const report = summarizeStudy(study, evidence);
  expect(report.chains[0]).toMatchObject({
    endpoint: parent.revision,
    decisions: { insufficient: 1 },
  });
  expect(report.cells).toHaveLength(8);
  expect(report.cells[0]).toMatchObject({
    reused: true,
    diff: null,
    pairedTasks: 2,
    unchangedBundle: true,
  });
  expect(report.costs.totalTokens).toBe(evidence.runs.length * 120);
});
it("rejects altered verdicts, changed conditions, missing attempt costs and premature finals", () => {
  const a = setup();
  const round = a.gated();
  assert(round.gate);
  round.gate.verdict.decision = "accept";
  expect(() => summarizeStudy(a.study, a.evidence)).toThrow("differs from evidence");
  const b = setup();
  b.finalA.a.spec.timeoutMin = 99;
  expect(summarizeStudy(b.study, b.evidence).cells[0]).toMatchObject({
    status: "incompatible",
    diff: null,
    pairedTasks: null,
  });
  const c = setup();
  c.evidence.runs.pop();
  c.evidence.allocation.pop();
  expect(() => summarizeStudy(c.study, c.evidence)).toThrow("missing from budget");
  const d = setup();
  d.finalA.a.createdAt = at(19);
  expect(() => summarizeStudy(d.study, d.evidence)).toThrow("before chain closure");
});
it("requires distinct editors, complete chains and declared final cells", () => {
  const a = setup();
  const first = a.evidence.rounds[0],
    second = a.evidence.rounds[1];
  assert(first && second);
  second.editorRun = first.editorRun;
  expect(() => summarizeStudy(a.study, a.evidence)).toThrow("duplicate editor");
  const b = setup();
  b.evidence.closed.pop();
  expect(() => summarizeStudy(b.study, b.evidence)).toThrow("chain not closed");
  const c = setup();
  c.evidence.finals.pop();
  expect(() => summarizeStudy(c.study, c.evidence)).toThrow("matrix incomplete");
});
it("requires unchanged admission policies and evolve-only provenance", () => {
  const a = setup();
  const round = a.gated();
  assert(round.gate);
  round.gate.policy.min_paired_tasks = 2;
  round.gate.verdict = gate(
    parent.revision,
    child.revision,
    round.gate.policy,
    round.gate.evidence,
  );
  expect(() => summarizeStudy(a.study, a.evidence)).toThrow("policy changed");
  const b = setup();
  const rb = b.gated();
  assert(rb.gate);
  const lineage = b.f.target.b.spec.lineage.candidate,
    entry = b.f.target.ra.methods[0]?.entries[0];
  assert(lineage && entry);
  lineage.informedBy = [entry.trial];
  rb.informedBy = lineage.informedBy;
  rb.gate.evidence.jobs = b.f.evidence.jobs;
  rb.gate.verdict = gate(parent.revision, child.revision, rb.gate.policy, rb.gate.evidence);
  expect(() => summarizeStudy(b.study, b.evidence)).toThrow("outside evolve partition");
});
it("computes paired per-task intervals for separate endpoint evaluations and exposes failed samples", () => {
  const { study, evidence, finalA } = setup();
  finalA.b.revisions.candidate = parent;
  const cell = evidence.finals[0];
  assert(cell?.child);
  cell.child = { ...cell.child, job: finalA.b.id };
  const result = summarizeStudy(study, evidence);
  expect(result.cells[0]?.diff).toMatchObject({ mean: 15, ci: [15, 15], tasks: 2 });
  const invalid = finalA.rb.methods[0]?.entries[0];
  assert(invalid);
  invalid.evaluation = "invalid";
  const partial = summarizeStudy(study, evidence).cells[0];
  expect(partial?.diff).toMatchObject({ tasks: 1, ci: null });
  expect(partial?.invalid).toEqual([0, 1]);
});
it("rejects cross-chain alpha history for independent-home studies", () => {
  const { study, evidence, gated } = setup();
  const r = gated();
  assert(r.gate);
  study.plan.history = "separate-homes";
  study.digest = contentDigest({ frozenAt: study.frozenAt, plan: study.plan });
  evidence.planDigest = study.digest;
  expect(summarizeStudy(study, evidence).chains[0]?.alphas).toHaveLength(1);
  const other = structuredClone(r.gate.evidence.jobs[1]);
  assert(other);
  other.id = "other-chain";
  other.createdAt = at(12);
  other.revisions.candidate = revisionOf({ ...child.basis, bundleDigest: "c".repeat(64) });
  const report = structuredClone(r.gate.evidence.reports[1]);
  assert(report);
  report.jobId = other.id;
  r.gate.evidence.jobs.push(other);
  r.gate.evidence.reports.push(report);
  r.gate.verdict = gate(parent.revision, child.revision, r.gate.policy, r.gate.evidence);
  expect(() => summarizeStudy(study, evidence)).toThrow("history crosses chains");
});

it("adopts only accepted candidates and compares their actual final revisions", () => {
  const f = setup();
  f.study.plan.policy.min_paired_tasks = 2;
  f.study.digest = contentDigest({ frozenAt: f.study.frozenAt, plan: f.study.plan });
  f.evidence.planDigest = f.study.digest;
  const round = f.gated();
  assert(round.gate);
  expect(round.gate.verdict.decision).toBe("accept");
  expect(() => summarizeStudy(f.study, f.evidence)).toThrow("endpoint");
  for (const cell of f.evidence.finals.filter((c) => c.chain === "a1")) {
    assert(cell.parent && cell.child);
    cell.child = { ...cell.child, job: cell.parent.job.replace(/-0$/, "-1") };
  }
  const report = summarizeStudy(f.study, f.evidence);
  expect(report.chains[0]?.endpoint).toBe(child.revision);
  expect(report.cells[0]?.diff?.mean).toBe(15);
  const entry = f.f.target.rb.methods[0]?.entries;
  assert(entry);
  for (const e of entry) e.value = 0;
  round.gate.evidence.reports = f.f.evidence.reports;
  round.gate.verdict = gate(
    parent.revision,
    child.revision,
    round.gate.policy,
    round.gate.evidence,
  );
  expect(round.gate.verdict.decision).toBe("reject");
  for (const cell of f.evidence.finals.filter((c) => c.chain === "a1")) cell.child = cell.parent;
  expect(summarizeStudy(f.study, f.evidence).chains[0]?.endpoint).toBe(parent.revision);
});
it("rejects mismatched editor configuration, unsafe mounts and oversize candidates", () => {
  const a = setup();
  const ra = a.gated();
  ra.editorConfiguration = { ...ra.editorConfiguration, model: "different" };
  expect(() => summarizeStudy(a.study, a.evidence)).toThrow("editor configuration");
  const b = setup();
  const editor = b.evidence.runs[0];
  assert(editor);
  editor.spec.hostNetwork = true;
  expect(() => summarizeStudy(b.study, b.evidence)).toThrow("isolation");
  const c = setup();
  const rc = c.gated();
  rc.changes = { lines: 100, bytes: 50 };
  expect(() => summarizeStudy(c.study, c.evidence)).toThrow("change budget");
});

it("reports explicitly unrun final cells and unknown costs without zero imputation", () => {
  const { study, evidence } = setup();
  const cell = evidence.finals[0],
    cost = evidence.runs[0];
  assert(cell && cost);
  cell.parent = null;
  cell.child = null;
  cell.notRun = "Unknown prior model usage blocks further submission";
  cost.tokens = null;
  const report = summarizeStudy(study, evidence);
  expect(report.cells[0]).toMatchObject({ status: "not_run", pairedTasks: null, diff: null });
  expect(report.comparisonCompleted).toBe(false);
  expect(report.costs.totalTokens).toBeNull();
  delete cell.notRun;
  expect(() => summarizeStudy(study, evidence)).toThrow("not-run reason");
});

it("requires resource templates for every selected task before freezing", () => {
  const { plan } = setup();
  const condition = plan.conditions[0];
  assert(condition);
  condition.resources = {};
  expect(() => freezeStudy(plan)).toThrow("resource overrides");
});

it("refuses shared candidate assessments across independent chains", () => {
  const { study, evidence, gated } = setup();
  const r = gated();
  study.plan.history = "separate-homes";
  study.digest = contentDigest({ frozenAt: study.frozenAt, plan: study.plan });
  evidence.planDigest = study.digest;
  const other = evidence.rounds[2];
  assert(other);
  other.gate = r.gate;
  expect(() => summarizeStudy(study, evidence)).toThrow("assessment reused");
});
