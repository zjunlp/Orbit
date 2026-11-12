// A saved test report in the Common Test Report Format (CTRF), as written by pytest, Jest and other
// runners. Artifacts are untrusted input: validate the shape and bound every list before rendering.

export const TEST_STATUSES = ["failed", "other", "pending", "skipped", "passed"] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

export interface TestCase {
  name: string;
  status: TestStatus;
  /** The runner's own word when it is not one of the CTRF statuses. */
  rawStatus?: string;
  durationMs: number | null;
  file?: string;
  message?: string;
  trace?: string;
  retries: number;
  tags: string[];
}

export interface TestsReport {
  tool: string | null;
  /** Failures first, then in the order of the report. */
  tests: TestCase[];
  counts: Record<TestStatus, number>;
  durationMs: number | null;
  /** Tests left out because the report is longer than the page shows. */
  omitted: number;
}

const MAX_TESTS = 2000;
const MAX_TEXT = 20_000;

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = MAX_TEXT): string | undefined =>
  typeof v === "string" && v.trim() ? (v.length > max ? `${v.slice(0, max)}…` : v) : undefined;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Elapsed milliseconds. CTRF timestamps are epoch milliseconds, but pytest's plugin writes epoch
 * seconds and a duration in seconds; the magnitude of the timestamps tells which one a file uses.
 */
function elapsed(start: unknown, stop: unknown, duration: unknown): number | null {
  if (finite(start) && finite(stop) && stop >= start && start > 0)
    return (stop - start) * (start < 1e11 ? 1000 : 1);
  return finite(duration) && duration >= 0 ? duration : null;
}

export function parseTestsReport(source: string): TestsReport {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("The test report is incomplete or is not valid JSON.");
  }
  const results = record(value) ? value.results : undefined;
  if (!record(results) || !Array.isArray(results.tests))
    throw new Error("This is not a CTRF test report: results.tests is missing.");
  const counts: Record<TestStatus, number> = {
    failed: 0,
    other: 0,
    pending: 0,
    skipped: 0,
    passed: 0,
  };
  const tests: TestCase[] = [];
  for (const row of results.tests) {
    if (!record(row) || typeof row.name !== "string" || typeof row.status !== "string")
      throw new Error("The test report has a test without a name or status.");
    const known = (TEST_STATUSES as readonly string[]).includes(row.status);
    const status = known ? (row.status as TestStatus) : "other";
    counts[status]++;
    if (tests.length >= MAX_TESTS) continue;
    const seconds = finite(row.start) && row.start < 1e11;
    tests.push({
      name: text(row.name, 500) ?? "(unnamed test)",
      status,
      rawStatus: known ? text(row.raw_status ?? row.rawStatus, 40) : text(row.status, 40),
      durationMs:
        elapsed(row.start, row.stop, undefined) ??
        (finite(row.duration) && row.duration >= 0 ? row.duration * (seconds ? 1000 : 1) : null),
      file: text(row.file_path ?? row.filePath, 500),
      message: text(row.message),
      trace: text(row.trace),
      retries: finite(row.retries) && row.retries > 0 ? Math.floor(row.retries) : 0,
      tags: Array.isArray(row.tags)
        ? row.tags.filter((t): t is string => typeof t === "string").slice(0, 8)
        : [],
    });
  }
  const order = (t: TestCase) => TEST_STATUSES.indexOf(t.status);
  const summary = record(results.summary) ? results.summary : {};
  const total = tests.reduce<number | null>(
    (a, t) => (t.durationMs === null ? a : (a ?? 0) + t.durationMs),
    null,
  );
  return {
    tool: record(results.tool) ? (text(results.tool.name, 60) ?? null) : null,
    tests: tests
      .map((t, i) => [t, i] as const)
      .sort((a, b) => order(a[0]) - order(b[0]) || a[1] - b[1])
      .map(([t]) => t),
    counts,
    durationMs: elapsed(summary.start, summary.stop, undefined) ?? total,
    omitted: results.tests.length - tests.length,
  };
}
