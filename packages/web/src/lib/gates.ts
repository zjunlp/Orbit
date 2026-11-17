import type { GateRecord, GateRecordSummary } from "@zjunlp/orbit/contracts";

export const gatePath = (id: string) => `/configurations/gates/${encodeURIComponent(id)}`;
export const verdictLabel = (record: GateRecordSummary) =>
  record.mode === "calibration-aa"
    ? `A/A · ${record.verdict.decision === "accept" ? "Improvement signal" : record.verdict.decision === "reject" ? "Rejected" : "Inconclusive"}`
    : { accept: "Accepted", reject: "Rejected", insufficient: "Insufficient evidence" }[
        record.verdict.decision
      ];

/** Only the exact selected immutable report entries may supply comparison attempts. */
export function gatePairs(record: GateRecord, set: string, task: string) {
  const selection = record.evidence.selections.find((s) => s.set === set);
  if (
    !selection ||
    record.verdict.inputs.taskSets.find((s) => s.set === set)?.excluded.some((e) => e.task === task)
  )
    return [];
  const entries = (side: "parent" | "child") => {
    const ref = selection[side];
    return (
      record.evidence.reports
        .find((r) => r.jobId === ref.job && r.revision === ref.revision)
        ?.methods.find((m) => m.method === ref.method)?.entries ?? []
    );
  };
  const right = new Map(
    entries("child")
      .filter((e) => e.task === task)
      .map((e) => [e.sample, e]),
  );
  return entries("parent")
    .filter((e) => e.task === task)
    .flatMap((parent) => {
      const child = right.get(parent.sample);
      return child &&
        parent.evaluation === "valid" &&
        child.evaluation === "valid" &&
        parent.value !== null &&
        child.value !== null
        ? [{ sample: parent.sample, parent, child, selection }]
        : [];
    });
}
