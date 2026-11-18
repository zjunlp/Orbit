// Synthetic archived evidence rendered through the real matrix components.
import assert from "node:assert/strict";
import { GateRecord } from "@zjunlp/orbit/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { transferMatrix } from "../../orbit/src/bench/transfer.ts";
import { fixture } from "../../orbit/test/fixtures/gate.ts";
import { gateTransferPath } from "../src/lib/gates.ts";
import { TransferDetail, TransferView } from "../src/pages/Transfer.tsx";

vi.mock("../src/lib/router.ts", () => ({
  useLocation: () => ({ query: new URLSearchParams() }),
  setQuery: vi.fn(),
  onLinkClick: vi.fn(),
}));
function record() {
  const f = fixture();
  f.policy.final.push({
    benchmark: "heldout",
    tasks: { file: "missing.txt", sha256: "c".repeat(64) },
    agents: ["other-agent"],
  });
  return GateRecord.parse({
    id: "synthetic",
    createdAt: "2026-11-17T00:00:00Z",
    evaluator: "orbit-gate/1",
    mode: "promotion",
    policy: f.policy,
    evidence: f.evidence,
    verdict: f.check(),
  });
}
it("shows exact differences, blank missing evidence and no aggregate score", () => {
  const matrix = transferMatrix([record()]);
  const html = renderToStaticMarkup(<TransferView matrix={matrix} />);
  expect(html).toContain("Δ +15");
  expect(html).toContain("[15, 15]");
  expect(html).toContain("60/60 eligible tasks paired");
  expect(html).toContain("Missing evidence");
  expect(html).toContain('aria-label="No comparable estimate"');
  expect(html).not.toContain("Δ 0");
  expect(html).not.toContain("Overall score");
  expect(html).not.toContain("<tfoot");
});
it("shows repeated assessments without selecting the best one and links archived evidence", () => {
  const r = record();
  const repeated = structuredClone(r);
  repeated.id = "repeat";
  const matrix = transferMatrix([r, repeated]);
  const html = renderToStaticMarkup(<TransferView matrix={matrix} />);
  expect(html).toContain("2 assessments");
  expect(html).not.toContain("Δ +15");
  const row = matrix.rows[0];
  const column = matrix.columns.find((c) => c.role === "gate");
  assert(row && column);
  const assessments = row.cells.find((c) => c.column === column.id)?.assessments;
  assert(assessments);
  const detail = renderToStaticMarkup(
    <TransferDetail row={row} column={column} assessments={assessments} />,
  );
  expect(detail).toContain("/configurations/gates/synthetic");
  expect(detail).toContain("/configurations/gates/repeat");
  expect(detail).toContain("gate-0@1:candidate");
  expect(detail).toContain("gate-1@1:candidate");
  expect(detail).toContain(r.verdict.inputs.policyDigest);
  expect(detail).toContain("Whole-record decision:");
  expect(detail).toContain("Higher is better");
});
it("handles empty results, incompatible conditions and stale selections", () => {
  expect(renderToStaticMarkup(<TransferView matrix={transferMatrix([])} />)).toContain(
    "No saved transfer evidence",
  );
  const r = record();
  const job = r.evidence.jobs[1];
  assert(job?.benchmarkSnapshot?.labels?.identity);
  job.benchmarkSnapshot.labels.identity.version = "2";
  const matrix = transferMatrix([r]);
  const html = renderToStaticMarkup(
    <TransferView matrix={matrix} rowId="stale" columnId="stale" />,
  );
  expect(html).toContain("Incompatible conditions");
  expect(html).not.toContain("Δ +15");
  expect(html).toContain("selected cell has no evidence");
});
it("links a saved verdict to its exact bundle change and excludes calibration links", () => {
  const r = record();
  expect(gateTransferPath(r)).toBe(
    `/configurations/transfer?parentBundle=${"a".repeat(64)}&childBundle=${"b".repeat(64)}`,
  );
  r.mode = "calibration-aa";
  expect(gateTransferPath(r)).toBeNull();
});
