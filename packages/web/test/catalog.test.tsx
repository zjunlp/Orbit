import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { CalibrationReport, CatalogEntry } from "../src/lib/api.ts";
import { CalibrationCell, CalibrationDetail, calState } from "../src/pages/bench/Catalog.tsx";

vi.mock("../src/lib/router.ts", () => ({
  useLocation: () => ({ query: new URLSearchParams() }),
  setQuery: vi.fn(),
  onLinkClick: vi.fn(),
}));

const report = (over: Partial<CalibrationReport> = {}): CalibrationReport => ({
  benchmark: "b",
  job: "j1",
  tasks: ["t1", "t2"],
  methods: ["empty", "oracle"],
  seeds: 2,
  phase: "done",
  calibrated: true,
  checks: [
    { name: "evaluation valid", result: "passed", detail: "ok", trials: [] },
    { name: "empty score", result: "not_run", detail: "no expectation", trials: [] },
  ],
  createdAt: "2026-11-05T00:00:00.000Z",
  endedAt: "2026-11-05T00:10:00.000Z",
  source: null,
  ...over,
});
const entry = (calibrations: CalibrationReport[]) =>
  ({
    benchmark: { name: "b" },
    listing: null,
    capabilities: null,
    listingError: null,
    refreshing: false,
    calibrations,
    jobs: 1,
    methods: [],
    fidelity: "experimental",
  }) as unknown as CatalogEntry;

it("tells passed, failed, running and missing calibrations apart", () => {
  expect(calState(entry([]))).toBe("none");
  expect(calState(entry([report()]))).toBe("passed");
  expect(calState(entry([report({ calibrated: false })]))).toBe("failed");
  expect(calState(entry([report({ phase: "rescoring", calibrated: false })]))).toBe("running");
  // Only the latest calibration counts; earlier ones are history.
  expect(calState(entry([report({ calibrated: false }), report()]))).toBe("failed");
});

it("shows skipped checks and links failing trials to their evidence", () => {
  const cell = renderToStaticMarkup(<CalibrationCell e={entry([report()])} />);
  expect(cell).toContain("Passed");
  expect(cell).toContain("1 not applicable");
  const failed = report({
    calibrated: false,
    checks: [
      {
        name: "cleanup confirmed",
        result: "failed",
        detail: "1/8: t1/oracle#1",
        trials: ["j1.00003"],
      },
    ],
  });
  const html = renderToStaticMarkup(<CalibrationDetail e={entry([failed])} />);
  expect(html).toContain("/bench/j1/trials/j1.00003");
  expect(html).toContain("cleanup confirmed");
  expect(renderToStaticMarkup(<CalibrationDetail e={entry([])} />)).toContain(
    "No calibration recorded",
  );
});
