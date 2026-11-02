import { pairedDiff } from "@zjunlp/orbit/metrics";
import type { BenchCompare, BenchJob, Trial } from "../../lib/api.ts";

export function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableValue(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function jobConditions(job: BenchJob): Record<string, string> {
  return {
    Benchmark: job.spec.benchmark,
    ...job.capabilities?.conditions,
    "Source revision": job.source
      ? `${job.source.commit}${job.source.dirty ? " (modified checkout)" : ""}`
      : "Not recorded",
    "Environment settings": job.benchmarkSnapshot
      ? stableValue(job.benchmarkSnapshot.config)
      : "Not recorded",
    Adapter: job.benchmarkSnapshot?.adapter ?? "Not recorded",
    "Environment variables": job.benchmarkSnapshot
      ? stableValue(job.benchmarkSnapshot.env)
      : "Not recorded",
    "Verifier variable names": job.benchmarkSnapshot
      ? [...job.benchmarkSnapshot.passEnv].sort().join(", ")
      : "Not recorded",
    "Task set": [...job.spec.tasks].sort().join(", "),
    Repetitions: String(job.spec.seeds),
    "Timeout override": job.spec.timeoutMin ? `${job.spec.timeoutMin} min` : "Environment default",
    "Resource overrides": job.resources ? stableValue(job.resources) : "Environment default",
    Options: stableValue(job.spec.options),
  };
}

export function conditionDifferences(jobs: BenchJob[]): string[] {
  const values = jobs.map(jobConditions);
  const keys = [...new Set(values.flatMap((v) => Object.keys(v)))];
  return keys.filter((key) => new Set(values.map((v) => v[key] ?? "Not recorded")).size > 1);
}

export function unfinishedTask(t: Trial, job: BenchJob): boolean {
  return (
    job.capabilities?.scoreKind === "binary" &&
    t.outcome?.evaluation === "valid" &&
    t.outcome.score === 0
  );
}

export function matchesTrial(t: Trial, job: BenchJob, filter: string): boolean {
  if (filter === "unfinished") return unfinishedTask(t, job);
  if (filter === "issues")
    return Boolean(t.outcome && (t.outcome.evaluation !== "valid" || t.outcome.issues.length > 0));
  if (filter === "active") return t.state !== "done";
  return true;
}

export function comparisonChange(
  base: number | null | undefined,
  value: number | null | undefined,
  higherIsBetter: boolean,
): string {
  if (base == null || value == null) return "unavailable";
  if (base === value) return "unchanged";
  return value > base === higherIsBetter ? "improved" : "regressed";
}

export function withBaseline(comparison: BenchCompare, baseline: string): BenchCompare {
  const selected = comparison.columns.find((c) => c.key === baseline);
  if (!selected || comparison.columns[0]?.key === baseline) return comparison;
  const columns = [selected, ...comparison.columns.filter((c) => c.key !== baseline)];
  const stats = { ...comparison.stats };
  for (const metric of comparison.metrics) {
    const previous = comparison.stats[metric.name];
    if (!previous) continue;
    const means = (key: string) =>
      new Map(
        comparison.rows.flatMap((row) => {
          const value = row.values[metric.name]?.[key];
          return value == null ? [] : [[row.task, { mean: value }] as const];
        }),
      );
    const base = means(baseline);
    stats[metric.name] = {
      ...previous,
      columns: Object.fromEntries(
        columns.map((column) => [
          column.key,
          {
            all: previous.columns[column.key]?.all ?? null,
            paired: previous.columns[column.key]?.paired ?? null,
            diff: column.key === baseline ? null : pairedDiff(base, means(column.key)),
          },
        ]),
      ),
    };
  }
  return { ...comparison, columns, stats };
}
