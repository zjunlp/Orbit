import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { matchesTaxonomy, readTaxonomyFilters } from "../src/lib/taxonomy.ts";
import { useAsync } from "../src/lib/use.ts";
import {
  Overview,
  OverviewTaxonomy,
  overviewDimensions,
  taxonomyOverviewHref,
} from "../src/pages/Overview.tsx";

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
const emptyCatalog = { entries: [], supported: [] };
function render(catalog = loaded(emptyCatalog), methods = loaded([])) {
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
  const html = render(loaded(emptyCatalog, "Connection lost"));
  expect(html).toContain("Showing the last loaded data.");
  expect(html).toContain("Getting started");
});
it("does not present pending configurations as zero versions", () => {
  const html = render(loaded(emptyCatalog), { ...loaded(undefined), loading: true });
  expect(html).toContain("Loading overview");
  expect(html).not.toContain("0 named configurations");
});

it("uses each comparison's metric unit and improvement direction", () => {
  const html = render(
    loaded(emptyCatalog),
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

const robot = {
  id: "robot",
  taxonomyGroups: [
    {
      label: "Control",
      taxonomy: {
        domains: ["robotics"],
        taskTypes: ["manipulation"],
        targets: ["control"],
        modalities: ["image"],
        interfaces: ["physical-control"],
        platforms: ["simulation"],
        world: ["controlled"],
        feedback: ["step"],
        participants: [],
        scoringEvidence: ["final-state"],
        scoringMethods: ["rule-check"],
      },
    },
  ],
};
const mixed = {
  id: "mixed",
  taxonomyGroups: [
    {
      label: "Science",
      taxonomy: {
        domains: ["science"],
        taskTypes: ["analysis"],
        targets: ["reasoning"],
        modalities: ["text"],
        interfaces: ["terminal"],
        platforms: ["software-system"],
        world: ["controlled"],
        feedback: ["none"],
        participants: [],
        scoringEvidence: ["artifact"],
        scoringMethods: ["execution-test"],
      },
    },
    {
      label: "Browser",
      taxonomy: {
        domains: ["software"],
        taskTypes: ["repair"],
        targets: ["tool-use"],
        modalities: ["image"],
        interfaces: ["gui"],
        platforms: ["browser"],
        world: ["live"],
        feedback: ["step"],
        participants: ["simulated-user"],
        scoringEvidence: ["final-state"],
        scoringMethods: ["rule-check"],
      },
    },
  ],
};
const unknown = { id: "unknown", taxonomyGroups: [{ label: "Unannotated", taxonomy: {} }] };

it("shows product families independently from repeated local registrations", () => {
  const html = render(
    loaded({
      supported: [robot, mixed, robot],
      entries: Array.from({ length: 5 }, () => ({ calibrations: [], methods: [] })),
    }),
  );
  expect(html).toContain("<b>2</b><span>benchmark families</span>");
  expect(html).toContain("<b>5</b> local setups");
  expect(html).not.toMatch(/C[1-7] |\/7 categories|By category/);
  expect(html).toContain("mode=local");
  expect(html).toContain("dimension=domain");
});

it("counts known profile values once per family and keeps absent values explicit", () => {
  const dimensions = overviewDimensions([robot, robot, mixed, unknown]);
  expect(dimensions).toHaveLength(6);
  const domains = dimensions.find((g) => g.id === "domain")?.fields[0]?.values;
  expect(domains?.find((v) => v.value === "robotics")?.count).toBe(1);
  expect(domains?.find((v) => v.value === "science")?.count).toBe(1);
  expect(domains?.some((v) => v.value === "unlabeled")).toBe(false);
  const participants = dimensions
    .find((g) => g.id === "environment")
    ?.fields.find((f) => f.field === "participants")?.values;
  expect(participants?.find((v) => v.value === "__none__")?.count).toBe(2);
  expect(participants?.find((v) => v.value === "simulated-user")?.count).toBe(1);
  expect(
    overviewDimensions([unknown])
      .flatMap((g) => g.fields)
      .every((f) => !f.values.length),
  ).toBe(true);
});

it("links six dimensions and their values to the same product filters used by Benchmarks", () => {
  const products = [robot, robot, mixed, unknown];
  for (const group of overviewDimensions(products)) {
    const groupUrl = new URL(taxonomyOverviewHref(group.id), "http://orbit.local");
    expect(groupUrl.searchParams.get("dimension")).toBe(group.id);
    for (const field of group.fields)
      for (const value of field.values) {
        const url = new URL(
          taxonomyOverviewHref(group.id, field.field, value.value),
          "http://orbit.local",
        );
        expect(url.pathname).toBe("/benchmarks");
        expect(url.searchParams.has("mode")).toBe(false);
        expect(url.searchParams.has("category")).toBe(false);
        expect(url.searchParams.has("domain")).toBe(false);
        const shown = products.filter((p) =>
          matchesTaxonomy(p, readTaxonomyFilters(url.searchParams)),
        );
        expect(new Set(shown.map((p) => p.id)).size).toBe(value.count);
      }
  }
  const html = renderToStaticMarkup(<OverviewTaxonomy products={products} />);
  expect(html.match(/class="overview-dimension"/g)).toHaveLength(6);
  for (const label of [
    "Domain",
    "Task type",
    "Evaluation target",
    "Interface &amp; modality",
    "Environment &amp; interaction",
    "Scoring",
  ])
    expect(html).toContain(`<h3>${label}</h3>`);
  expect(html).toContain("GUI interaction");
  expect(html).toContain("scoringMethods=rule-check");
  expect(html).toContain("Counts describe the product library and may overlap");
});
