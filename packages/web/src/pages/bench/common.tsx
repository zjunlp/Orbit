import type { BenchJob, MethodSummary } from "../../lib/api.ts";

export const jobLabel = (j: BenchJob) => j.spec.name ?? j.id;

export function JobState({ state }: { state: BenchJob["state"] }) {
  const cls = state === "cancelled" ? "warn" : "";
  return <span className={`chip ${cls}`}>{state}</span>;
}

/** Stacked valid / invalid / unknown / pending bar. */
export function EvalBar({ s }: { s: MethodSummary }) {
  const part = (n: number, c: string, label: string) =>
    n > 0 && (
      <span title={`${n} ${label}`} style={{ width: `${(100 * n) / s.trials}%`, background: c }} />
    );
  return (
    <div className="evalbar">
      {part(s.valid, "var(--st-succeeded)", "valid")}
      {part(s.invalid, "var(--st-failed)", "invalid")}
      {part(s.unknown, "var(--st-cancelled)", "unknown")}
      {part(s.pending, "var(--st-queued)", "pending")}
    </div>
  );
}

export const summaryTitle = (s: MethodSummary) =>
  `${s.valid} valid · ${s.invalid} invalid · ${s.unknown} unknown · ${s.pending} pending`;
