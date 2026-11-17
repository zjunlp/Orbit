import assert from "node:assert/strict";
import { GateRecord } from "@zjunlp/orbit/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { fixture, method } from "../../orbit/test/fixtures/gate.ts";
import { gatePairs, verdictLabel } from "../src/lib/gates.ts";
import { GateBadge, GateDetail, GateRecords } from "../src/pages/Gates.tsx";

vi.mock("../src/lib/router.ts", () => ({
  useLocation: () => ({ query: new URLSearchParams() }),
  setQuery: vi.fn(),
  onLinkClick: vi.fn(),
}));
function record() {
  const f = fixture();
  for (const e of method(f.target.ra).entries) e.value = 100;
  for (const e of method(f.target.rb).entries) e.value = 0;
  return GateRecord.parse({
    id: "synthetic-gate",
    createdAt: "2026-11-16T00:00:00Z",
    evaluator: "orbit-gate/1",
    mode: "promotion",
    policy: f.policy,
    evidence: f.evidence,
    verdict: f.check(),
  });
}
it("shows rejection reasons, frozen reports, alpha and regression comparisons", () => {
  const r = record();
  const html = renderToStaticMarkup(<GateDetail record={r} />);
  expect(html).toContain("Rejected");
  expect(html).toContain("Compare trajectories");
  expect(html).toContain("Frozen report selections");
  expect(html).toContain(r.verdict.inputs.policyDigest);
  expect(html).toContain("Round 1");
  expect(html).toContain("One-sided bounds");
});
it("distinguishes missing evidence from rejection and calibration from promotion", () => {
  const r = record();
  r.verdict.decision = "insufficient";
  const html = renderToStaticMarkup(<GateDetail record={r} />);
  expect(html).toContain("Insufficient evidence");
  expect(html).toContain("What evidence is missing");
  r.mode = "calibration-aa";
  r.verdict.decision = "accept";
  r.verdict.level = null;
  expect(verdictLabel(r)).toBe("A/A · Improvement signal");
  const badge = renderToStaticMarkup(<GateBadge record={r} />);
  expect(badge).toContain("calibration");
  expect(badge).not.toContain("Accepted");
  expect(renderToStaticMarkup(<GateRecords records={[]} />)).toContain("No gate records yet");
});
it("pairs attempts by immutable report and sample, never a later rescore", () => {
  const r = record();
  const entry = r.evidence.reports[0]?.methods[0]?.entries[0];
  assert(entry);
  const before = gatePairs(r, "gate", entry.task);
  expect(before.length).toBeGreaterThan(0);
  const report = r.evidence.reports[1];
  assert(report);
  const later = structuredClone(report);
  later.revision++;
  for (const e of method(later).entries) {
    e.solveRunId = "wrong-later-attempt";
    e.value = 100;
  }
  r.evidence.reports.push(later);
  expect(gatePairs(r, "gate", entry.task)).toEqual(before);
  expect(before[0]?.child.solveRunId).not.toBe("wrong-later-attempt");
  const set = r.verdict.inputs.taskSets[0];
  assert(set);
  set.excluded.push({
    task: entry.task,
    trial: entry.trial,
    revision: r.verdict.inputs.child,
  });
  expect(gatePairs(r, "gate", entry.task)).toEqual([]);
  expect(gatePairs(r, "unknown", entry.task)).toEqual([]);
});

it("shows the selected metric for the target and each guard", () => {
  const r = record();
  r.policy.gate.metric = "resolved";
  r.policy.guard.push({
    benchmark: "gui",
    tasks: { file: "gui.txt", sha256: "a".repeat(64) },
    metric: "success",
    margin: 5,
  });
  const html = renderToStaticMarkup(<GateDetail record={r} />);
  expect(html).toContain("fixture: resolved");
  expect(html).toContain("gui: success");
});
