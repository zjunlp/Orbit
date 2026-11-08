import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { useAsync } from "../src/lib/use.ts";
import { Overview } from "../src/pages/Overview.tsx";

vi.mock("../src/lib/use.ts", () => ({ useAsync: vi.fn(), usePageVisible: () => true }));
vi.mock("../src/lib/runs-store.ts", () => ({ useRuns: () => [] }));
vi.mock("../src/lib/router.ts", () => ({
  useLocation: () => ({ query: new URLSearchParams(), path: "/" }),
  setQuery: vi.fn(),
  navigate: vi.fn(),
  onLinkClick: vi.fn(),
}));
const loaded = (data: unknown, error: string | null = null) => ({
  data,
  error,
  loading: false,
  reload: vi.fn(),
});
beforeEach(() => vi.mocked(useAsync).mockReset());
function render(catalog = loaded([]), methods = loaded([])) {
  vi.mocked(useAsync)
    .mockReturnValueOnce(catalog)
    .mockReturnValueOnce(loaded({ agents: [], external: [] }))
    .mockReturnValueOnce(methods)
    .mockReturnValueOnce(loaded([]));
  return renderToStaticMarkup(<Overview />);
}
it("shows an actionable error when the first overview request fails", () => {
  const html = render(loaded(undefined, "Catalog unavailable"));
  expect(html).toContain("Catalog unavailable");
  expect(html).toContain("Retry");
  expect(html).not.toContain("Loading overview");
  expect(html).not.toContain("Nothing running.");
});
it("keeps loaded data visible with a stale-data warning on refresh failure", () => {
  const html = render(loaded([], "Connection lost"));
  expect(html).toContain("Showing the last loaded data.");
  expect(html).toContain("Getting started");
});
it("does not present pending methods as zero revisions", () => {
  const html = render(loaded([]), { ...loaded(undefined), loading: true });
  expect(html).toContain("Loading overview");
  expect(html).not.toContain("0 method lines");
});

it("uses each comparison's metric unit and improvement direction", () => {
  const html = render(
    loaded([]),
    loaded([
      {
        name: "candidate",
        agents: ["codex"],
        revisions: [
          {
            revision: "bbbbbbbbbbbb",
            lineage: null,
            results: [
              {
                job: "next",
                benchmark: "latency-check",
                at: "2026-11-06T00:00:00Z",
                condition: "condition",
                taskSet: "tasks",
                metric: {
                  name: "latency",
                  label: "Latency",
                  unit: "s",
                  higherIsBetter: false,
                  primary: true,
                },
                versus: {
                  revision: "aaaaaaaaaaaa",
                  pairedTasks: 3,
                  subset: false,
                  diff: { mean: 2, ci: [1, 3] },
                },
              },
            ],
          },
        ],
      },
    ]),
  );
  expect(html).toContain("delta-down");
  expect(html).toContain("Latency");
  expect(html).toContain("+2 s");
  expect(html).toContain("metric=latency");
  expect(html).toContain("c=condition");
});
