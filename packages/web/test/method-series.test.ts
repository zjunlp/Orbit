import { expect, it, vi } from "vitest";
import type { MethodLine, MethodRevisionEntry } from "../src/lib/api.ts";
import { benchmarkSeries, resultHref } from "../src/pages/Configurations.tsx";

vi.mock("../src/lib/router.ts", () => ({
  useLocation: () => ({ query: new URLSearchParams(), path: "/configurations" }),
  setQuery: vi.fn(),
  onLinkClick: vi.fn(),
}));

it("keeps changed benchmark conditions and regression subsets out of the full-set trend", () => {
  const results = [
    { job: "old-full", benchmark: "b", condition: "v1", taskSet: "full", at: "01" },
    { job: "new-full", benchmark: "b", condition: "v1", taskSet: "full", at: "04" },
    { job: "subset", benchmark: "b", condition: "v1", taskSet: "subset", at: "02" },
    { job: "new-benchmark", benchmark: "b", condition: "v2", taskSet: "full", at: "03" },
    { job: "other", benchmark: "other", condition: "v1", taskSet: "full", at: "05" },
  ];
  const line = { revisions: [{ revision: "r", results }] } as unknown as MethodLine;
  expect(benchmarkSeries(line, "b", "v1", "full").map(({ x }) => x.job)).toEqual([
    "old-full",
    "new-full",
  ]);
  expect(benchmarkSeries(line, "b", "v1", "subset").map(({ x }) => x.job)).toEqual(["subset"]);
});

it("links frozen results to their saved report and live results to the evaluation", () => {
  const result = { job: "j-a", reportRevision: 2 } as MethodRevisionEntry["results"][number];
  expect(resultHref(result)).toBe("/bench/j-a?report=2");
  expect(resultHref({ ...result, reportRevision: null })).toBe("/bench/j-a");
});
