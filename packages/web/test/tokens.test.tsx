import { BenchCompare, Run, type RunTokens } from "@zjunlp/orbit/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { formatTokens, formatTokenUsage } from "../src/lib/format.ts";
import { useAsync } from "../src/lib/use.ts";
import { BenchComparePage } from "../src/pages/bench/Compare.tsx";
import { Overview } from "../src/pages/run/Overview.tsx";

vi.mock("../src/lib/use.ts", () => ({ useAsync: vi.fn(() => ({ data: undefined, error: null })) }));
vi.mock("../src/lib/runs-store.ts", () => ({
  upsertRun: vi.fn(),
  useRuns: () => [],
  useRunsState: () => ({}),
}));
vi.mock("../src/lib/router.ts", () => ({
  useLocation: () => ({ query: new URLSearchParams("jobs=job") }),
  onLinkClick: vi.fn(),
  setQuery: vi.fn(),
}));
const tokens: RunTokens = {
  input: 0,
  cachedInput: null,
  cacheWrite: 0,
  output: 5,
  reasoning: null,
  calls: 1,
  source: "session",
};
const run = Run.parse({
  id: "tokens",
  spec: { backend: "process", command: ["true"] },
  state: "succeeded",
  reason: null,
  exitCode: 0,
  node: "fixture",
  image: null,
  containerId: null,
  lease: null,
  code: null,
  cleanup: "done",
  note: "",
  createdAt: "2026-11-13T00:00:00Z",
  startedAt: null,
  endedAt: "2026-11-13T00:01:00Z",
});
it("renders unreported usage distinctly from reported zero on Run details", () => {
  const render = (r: Run) =>
    renderToStaticMarkup(<Overview run={r} metrics={undefined} now={0} onTab={() => {}} />);
  expect(render(run)).toContain("Not recorded");
  const html = render({ ...run, tokens });
  expect(html).toContain("input 0");
  expect(html).toContain("cached input not recorded");
  expect(html).toContain("cache write 0");
  expect(html).not.toContain("$0.");
});
it("shows recorded coverage on comparisons without changing score statistics", () => {
  const tokenUsage = { runs: 3, recordedRuns: 2, tokens };
  const c = BenchCompare.parse({
    columns: [{ key: "m", jobId: "job", method: "m", benchmark: "fixture", tokenUsage }],
    rows: [],
    metrics: [{ name: "score", label: "Score", unit: "%", higherIsBetter: true, primary: true }],
    stats: {
      score: {
        pairedTasks: 0,
        pairedTaskIds: [],
        columns: { m: { all: null, paired: null, diff: null } },
      },
    },
  });
  vi.mocked(useAsync)
    .mockReturnValueOnce({ data: [], error: null } as ReturnType<typeof useAsync>)
    .mockReturnValueOnce({ data: { key: "job", value: c }, error: null } as ReturnType<
      typeof useAsync
    >)
    .mockReturnValueOnce({ data: [], error: null } as ReturnType<typeof useAsync>);
  const html = renderToStaticMarkup(<BenchComparePage />);
  expect(html).toContain("Tokens (all solve attempts)");
  expect(html).toContain("2/3 runs recorded");
  expect(html).toContain("input 0");
  expect(formatTokenUsage(undefined)).toBe("Not recorded");
  expect(formatTokenUsage({ runs: 3, recordedRuns: 0, tokens: null })).toContain("Not recorded");
  expect(formatTokens({ ...tokens, costUsd: 0.123 })).toContain("$0.123000 reported");
});
