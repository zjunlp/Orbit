// Synthetic immutable assessments; no Agent, model or experiment is run.
import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { gate } from "../src/bench/gate.ts";
import { revisionOf } from "../src/bench/revision.ts";
import { planDigest } from "../src/bench/summary.ts";
import { transferMatrix } from "../src/bench/transfer.ts";
import { formatTransfer } from "../src/cli/transfer.ts";
import { GateRecord, type TransferMatrix, TransferQuery } from "../src/contracts/index.ts";
import { fixture, method, parent } from "./fixtures/gate.ts";

function record(f = fixture(), id = "synthetic") {
  return GateRecord.parse({
    id,
    createdAt: "2026-11-17T00:00:00Z",
    evaluator: "orbit-gate/1",
    mode: "promotion",
    policy: f.policy,
    evidence: f.evidence,
    verdict: f.check(),
  });
}
const syncPlans = (f: ReturnType<typeof fixture>) => {
  for (const r of f.evidence.reports) {
    const j = f.evidence.jobs.find((j) => j.id === r.jobId);
    assert(j);
    r.planDigest = planDigest(j);
  }
};
const first = (m: TransferMatrix) => {
  const assessment = m.rows[0]?.cells[0]?.assessments[0];
  assert(assessment);
  return assessment;
};

describe("transfer evidence projection", () => {
  it("retains the exact saved estimates, checks and report references without modifying input", () => {
    const r = record();
    const before = structuredClone(r);
    const m = transferMatrix([r]);
    expect(m.rows).toHaveLength(1);
    expect(m.columns).toHaveLength(1);
    expect(m.rows[0]).toMatchObject({ parentBundle: "a".repeat(64), childBundle: "b".repeat(64) });
    const a = first(m);
    expect(a).toMatchObject({
      status: "pass",
      decision: "accept",
      eligible: 60,
      excluded: 0,
      parent: { job: "gate-0", revision: 1, method: "candidate" },
      child: { job: "gate-1", revision: 1, method: "candidate" },
      delta: { mean: 15, tasks: 60, ci: [15, 15] },
    });
    expect(a.checks).toEqual(r.verdict.checks);
    expect(r).toEqual(before);
  });

  it.each(["version", "resources", "model", "tasks"])(
    "splits %s differences into separate conditions",
    (change) => {
      const f = fixture(change === "tasks" ? 40 : 60);
      for (const job of f.evidence.jobs) {
        if (change === "version") {
          assert(job.benchmarkSnapshot?.labels?.identity);
          job.benchmarkSnapshot.labels.identity.version = "2";
        }
        if (change === "resources")
          job.resources = Object.fromEntries(job.spec.tasks.map((t) => [t, { cpus: 4, memGB: 8 }]));
        if (change === "model") {
          const rev = job.revisions.candidate;
          assert(rev && job.spec.methods[0]);
          job.revisions.candidate = revisionOf({ ...rev.basis, model: "other-model" });
          job.spec.methods[0].model = "other-model";
        }
      }
      if (change === "model") {
        const p = f.target.a.revisions.candidate;
        const c = f.target.b.revisions.candidate;
        assert(p && c);
        f.target.b.spec.lineage.candidate = { parent: p.revision, informedBy: [] };
        // The matrix reads immutable verdicts; the fixture's check closure names the original revisions.
        f.check = () => gate(p.revision, c.revision, f.policy, f.evidence);
      }
      syncPlans(f);
      const changed = record(f, "changed");
      const m = transferMatrix([record(), changed]);
      expect(m.rows).toHaveLength(1);
      expect(m.columns).toHaveLength(2);
      expect(m.rows[0]?.cells).toHaveLength(2);
      expect(m.rows[0]?.cells.every((c) => c.assessments[0]?.status === "pass")).toBe(true);
    },
  );

  it.each(["version", "resources"])(
    "suppresses estimates when parent and child %s differ",
    (change) => {
      const f = fixture();
      if (change === "version") {
        assert(f.target.b.benchmarkSnapshot?.labels?.identity);
        f.target.b.benchmarkSnapshot.labels.identity.version = "2";
      } else f.target.b.resources = Object.fromEntries(f.target.tasks.map((t) => [t, { cpus: 8 }]));
      syncPlans(f);
      const m = transferMatrix([record(), record(f, "incompatible")]);
      expect(m.columns).toHaveLength(2);
      const a = m.rows[0]?.cells
        .flatMap((c) => c.assessments)
        .find((a) => a.record === "incompatible");
      expect(a).toMatchObject({ status: "incompatible", delta: null });
    },
  );

  it("leaves missing selections blank, keeps optional final Agents and preserves real zero differences", () => {
    const f = fixture();
    for (const e of method(f.target.rb).entries) e.value = 50;
    f.policy.final.push({
      benchmark: "heldout",
      tasks: { file: "missing.txt", sha256: "c".repeat(64) },
      agents: ["other-agent"],
    });
    const m = transferMatrix([record(f)]);
    expect(m.columns).toHaveLength(2);
    const entries = m.rows[0]?.cells.flatMap((c) => c.assessments);
    expect(entries?.find((a) => a.set === "gate")).toMatchObject({
      status: "insufficient",
      delta: { mean: 0 },
    });
    expect(entries?.find((a) => a.set === "final:0:other-agent")).toMatchObject({
      status: "missing",
      delta: null,
    });
    expect(m.columns.find((c) => c.agent === "other-agent")).toMatchObject({
      role: "final",
      parent: null,
      child: null,
    });
  });

  it("preserves insufficient coverage and failures instead of calling them accepted", () => {
    const small = record(fixture(2));
    expect(first(transferMatrix([small]))).toMatchObject({
      status: "insufficient",
      delta: { mean: 15, tasks: 2 },
    });
    const f = fixture();
    for (const e of method(f.target.rb).entries) e.value = 0;
    expect(first(transferMatrix([record(f)]))).toMatchObject({
      status: "fail",
      decision: "reject",
      delta: { mean: -50 },
    });
  });

  it("does not present lineage-uncertain differences or unavailable report snapshots", () => {
    const f = fixture();
    f.target.b.spec.lineage.candidate = { parent: parent.revision, informedBy: ["unknown-trial"] };
    expect(first(transferMatrix([record(f)]))).toMatchObject({
      status: "insufficient",
      delta: null,
    });
    const missing = record();
    missing.evidence.reports = [];
    expect(first(transferMatrix([missing]))).toMatchObject({ status: "missing", delta: null });
  });

  it("retains every report assessment, including rescores, without choosing or averaging", () => {
    const f = fixture();
    f.target.rb.revision = 2;
    assert(f.evidence.selections[0]);
    f.evidence.selections[0].child.revision = 2;
    for (const e of method(f.target.rb).entries) e.value = 40;
    const old = record();
    const newer = record(f, "later");
    const m = transferMatrix([old, newer]);
    expect(m.columns).toHaveLength(1);
    const assessments = m.rows[0]?.cells[0]?.assessments;
    expect(assessments).toHaveLength(2);
    expect(assessments?.map((a) => a.delta?.mean).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      -10, 15,
    ]);
    expect(assessments?.find((a) => a.record === "synthetic")?.child?.revision).toBe(1);
    expect(assessments?.find((a) => a.record === "later")?.child?.revision).toBe(2);
    expect(transferMatrix([newer, old])).toEqual(m);
  });

  it("shows raw child-minus-parent for lower-is-better metrics without reversing the decision", () => {
    const f = fixture();
    f.policy.metric = "latency";
    for (const job of f.evidence.jobs)
      job.metrics = [
        { name: "latency", label: "Latency", unit: "s", higherIsBetter: false, primary: true },
      ];
    for (const r of f.evidence.reports) r.metric = "latency";
    syncPlans(f);
    const r = record(f);
    expect(r.verdict.checks.find((c) => c.kind === "improvement")?.diff?.mean).toBe(-15);
    const m = transferMatrix([r]);
    expect(first(m)).toMatchObject({ status: "fail", delta: { mean: 15, ci: [15, 15] } });
    expect(formatTransfer(m)).toContain("lower is better");
  });

  it("keeps final-Agent revisions separate from the original admission and whole-record decision", () => {
    const f = fixture();
    const g = f.pair("guard:0", "guard", Array(60).fill(50), Array(60).fill(0));
    f.policy.guard.push({ ...g.dataset, margin: 5 });
    const end = f.pair("final:0:other-agent", "heldout", undefined, undefined, "other-agent");
    f.policy.final.push({ ...end.dataset, agents: ["other-agent"] });
    const m = transferMatrix([record(f)]);
    const assessments = m.rows[0]?.cells.flatMap((c) => c.assessments);
    expect(assessments?.find((a) => a.set === "gate")).toMatchObject({
      status: "pass",
      decision: "reject",
    });
    expect(assessments?.find((a) => a.set === "final:0:other-agent")).toMatchObject({
      status: "pass",
      parentRevision: end.a.revisions.candidate?.revision,
      childRevision: end.b.revisions.candidate?.revision,
    });
    expect(m.columns).toHaveLength(3);
  });

  it("filters by full digests and identifies records that cannot represent a bundle change", () => {
    expect(
      transferMatrix([record()], { parentBundle: "a".repeat(64), childBundle: "c".repeat(64) })
        .rows,
    ).toEqual([]);
    const aa = record();
    aa.id = "aa";
    aa.mode = "calibration-aa";
    const approximate = record();
    approximate.id = "old";
    assert(approximate.evidence.jobs[0]?.revisions.candidate);
    approximate.evidence.jobs[0].revisions.candidate.approximate = true;
    expect(transferMatrix([aa, approximate])).toMatchObject({
      rows: [],
      columns: [],
      omitted: [
        { record: "aa", reason: "calibration" },
        { record: "old", reason: "unresolved-bundles" },
      ],
    });
    for (const q of [
      { parentBundle: "a".repeat(64) },
      { parentBundle: "a".repeat(12), childBundle: "b".repeat(64) },
      { parentBundle: "a".repeat(64), childBundle: "a".repeat(64) },
    ])
      expect(TransferQuery.safeParse(q).success).toBe(false);
    expect(formatTransfer(transferMatrix([]))).toContain("No saved evidence");
  });
});
