import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { gate } from "../packages/orbit/src/bench/gate.ts";
import { GateRecord } from "../packages/orbit/src/contracts/index.ts";
import { child, fixture, method, parent } from "../packages/orbit/test/fixtures/gate.ts";
import { calibrateGateRecords } from "./gate-calibration.ts";

function records() {
  const f = fixture();
  f.target.b.revisions.candidate = parent;
  f.target.b.spec.lineage = {};
  for (const e of method(f.target.rb).entries) e.value = 50;
  const aa = GateRecord.parse({
    id: "aa",
    createdAt: "2026-11-15T00:00:00Z",
    evaluator: "orbit-gate/1",
    mode: "calibration-aa",
    policy: f.policy,
    evidence: f.evidence,
    verdict: gate(parent.revision, parent.revision, f.policy, f.evidence, "calibration-aa"),
  });
  const g = fixture();
  for (const e of method(g.target.rb).entries) e.value = 0;
  const destructive = GateRecord.parse({
    id: "broken",
    createdAt: "2026-11-15T00:00:00Z",
    evaluator: "orbit-gate/1",
    mode: "promotion",
    policy: g.policy,
    evidence: g.evidence,
    verdict: gate(parent.revision, child.revision, g.policy, g.evidence),
  });
  return { aa, destructive };
}

describe("development gate calibration", () => {
  it("replays evidence, flags degenerate A/A resampling and verifies destructive harm", () => {
    const { aa, destructive } = records();
    const report = calibrateGateRecords(aa, destructive, 200, 42);
    expect(report.passed).toBe(true);
    expect(report.resampling).toMatchObject({ degenerate: true, acceptanceRate: 0, tasks: 60 });
    expect(calibrateGateRecords(aa, destructive, 200, 42)).toEqual(report);
    expect(() => calibrateGateRecords(aa, destructive, 0)).toThrow();
  });
  it("fails if the claimed verdict differs from evidence", () => {
    const { aa, destructive } = records();
    destructive.verdict.decision = "accept";
    expect(() => calibrateGateRecords(aa, destructive)).toThrow("does not match");
  });
  it("does not claim destructive calibration when rejection is only caused by cost", () => {
    const { aa, destructive } = records();
    const m = destructive.evidence.reports[1]?.methods[0];
    assert(m);
    for (const e of m.entries) e.value = 70;
    for (const c of m.costs ?? []) c.wallSeconds = 100;
    destructive.verdict = gate(
      parent.revision,
      child.revision,
      destructive.policy,
      destructive.evidence,
    );
    expect(destructive.verdict.decision).toBe("reject");
    expect(calibrateGateRecords(aa, destructive, 100).checks.destructive).toBe("failed");
  });
  it("does not mask an A/A statistical false positive behind a cost failure", () => {
    const { aa, destructive } = records();
    const m = aa.evidence.reports[1]?.methods[0];
    assert(m);
    for (const e of m.entries) e.value = 80;
    for (const c of m.costs ?? []) c.wallSeconds = 100;
    aa.verdict = gate(parent.revision, parent.revision, aa.policy, aa.evidence, "calibration-aa");
    expect(aa.verdict.decision).toBe("reject");
    expect(calibrateGateRecords(aa, destructive, 100).checks.aa).toBe("failed");
  });
});
