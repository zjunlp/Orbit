import type { BenchCatalog, CatalogEntry, SupportedBenchmark } from "@zjunlp/orbit/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { matchesTaxonomy } from "../src/lib/taxonomy.ts";
import { BenchmarksPage } from "../src/pages/Benchmarks.tsx";
import {
  BenchmarkLibrary,
  libraryEntry,
  SupportedCard,
} from "../src/pages/bench/BenchmarkLibrary.tsx";

const fixtureState = vi.hoisted(() => ({ query: "", data: undefined as unknown }));

vi.mock("../src/lib/router.ts", () => ({
  useLocation: () => ({ query: new URLSearchParams(fixtureState.query), path: "/benchmarks" }),
  setQuery: vi.fn(),
  onLinkClick: vi.fn(),
}));
vi.mock("../src/lib/use.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/use.ts")>()),
  useAsync: () => ({ data: fixtureState.data, error: null, loading: false, reload: vi.fn() }),
}));

const definition: SupportedBenchmark = {
  id: "fixture-family",
  name: "Fixture Benchmark",
  description: "Synthetic product metadata for UI checks.",
  taxonomyGroups: [
    {
      label: "Analysis protocol",
      taxonomy: {
        domains: ["science"],
        taskTypes: ["analysis"],
        interfaces: ["terminal"],
      },
    },
    {
      label: "Repair protocol",
      taxonomy: {
        domains: ["software"],
        taskTypes: ["repair"],
        interfaces: ["gui"],
      },
    },
  ],
  integrations: [
    { name: "Fixture adapter", url: "https://example.test/guide", scope: "A bounded test subset." },
  ],
  verification: {
    level: "pending-calibration",
    detail: "The adapter exists; real environment calibration remains pending.",
    url: "https://example.test/validation",
  },
  suites: ["Fixture suite"],
  registrationNames: [],
};

function registration(name: string): CatalogEntry {
  return {
    benchmark: {
      name,
      adapter: "harbor",
      path: "/fixture",
      config: {},
      env: {},
      passEnv: [],
      createdAt: "2026-11-09T00:00:00Z",
      updatedAt: "2026-11-09T00:00:00Z",
    },
    listing: null,
    capabilities: null,
    identity: { id: definition.id, name: definition.name },
    identitySource: "adapter",
    domains: ["science"],
    tags: [],
    listingError: null,
    refreshing: false,
    calibrations: [],
    jobs: 9876,
    methods: [],
    fidelity: "experimental",
  };
}

beforeEach(() => {
  fixtureState.query = "";
  fixtureState.data = { entries: [], supported: [definition] } satisfies BenchCatalog;
});

it("defaults to one product card despite twenty local setups and their run counts", () => {
  const entries = Array.from({ length: 20 }, (_, i) => registration(`fixture-local-${i}`));
  fixtureState.data = {
    entries,
    supported: [{ ...definition, registrationNames: entries.map((entry) => entry.benchmark.name) }],
  } satisfies BenchCatalog;
  const html = renderToStaticMarkup(<BenchmarksPage />);
  expect(html.match(/<article class="benchmark-card supported-benchmark/g)).toHaveLength(1);
  expect(html).toContain("<h2>Fixture Benchmark</h2>");
  expect(html).not.toContain("fixture-local-");
  expect(html).not.toContain("9876");
  expect(html).not.toContain("Registrations");
  expect(html).not.toContain("benchmark-evidence-strip");
  expect(html).toContain("Six classification dimensions");
});

it("shows integrated benchmarks before any local setup exists", () => {
  const html = renderToStaticMarkup(<BenchmarkLibrary />);
  expect(html).toContain("<h2>Fixture Benchmark</h2>");
  expect(html).toContain("Benchmark families");
  expect(html).not.toContain("Your benchmark library starts here");
  expect(html).not.toContain("No local setup could be matched automatically");
});

it("does not fall back to registration cards when an older daemon omits the product library", () => {
  fixtureState.data = { entries: [registration("fixture-old-local")] };
  const html = renderToStaticMarkup(<BenchmarkLibrary />);
  expect(html).toContain("The integration library is not available");
  expect(html).toContain("restart its daemon");
  expect(html).not.toContain("fixture-old-local");
});

it("filters one protocol at a time instead of combining a family display union", () => {
  const entry = libraryEntry(definition);
  expect(entry.taxonomy.domains).toEqual(["science", "software"]);
  expect(matchesTaxonomy(entry, { domains: ["science"], interfaces: ["gui"] })).toBe(false);
  expect(matchesTaxonomy(entry, { domains: ["software"], interfaces: ["gui"] })).toBe(true);
  fixtureState.query = "domains=science&interfaces=gui";
  expect(renderToStaticMarkup(<BenchmarkLibrary />)).toContain("No benchmarks match these filters");
  fixtureState.query = "domains=software&interfaces=gui";
  expect(renderToStaticMarkup(<BenchmarkLibrary />)).toContain("<h2>Fixture Benchmark</h2>");
});

it("shows pending verification honestly and keeps setup links inside expanded details", () => {
  const entry = libraryEntry({ ...definition, registrationNames: ["fixture-local"] });
  const closed = renderToStaticMarkup(
    <SupportedCard entry={entry} open={false} toggle={vi.fn()} />,
  );
  expect(closed).toContain("Calibration pending");
  expect(closed).not.toContain("Sample checked");
  expect(closed).not.toContain("fixture-local");
  const opened = renderToStaticMarkup(<SupportedCard entry={entry} open toggle={vi.fn()} />);
  expect(opened).toContain("real environment calibration remains pending");
  expect(opened).toContain("Supported scope");
  expect(opened).toContain("Local setups (1)");
  expect(opened).toContain("mode=local&amp;setup=fixture-local&amp;open=fixture-local");
  expect(opened).toContain("/bench/new?benchmark=fixture-local");
});

it("explains an unconfigured benchmark in details without inventing an evaluation link", () => {
  const html = renderToStaticMarkup(
    <SupportedCard entry={libraryEntry(definition)} open toggle={vi.fn()} />,
  );
  expect(html).toContain("No local setup could be matched automatically");
  expect(html).toContain('href="/benchmarks?mode=local"');
  expect(html).toContain('href="https://example.test/guide"');
  expect(html).not.toContain("/bench/new?benchmark=");
});

it("describes VLA models as evaluated policies within physical-control benchmark details", () => {
  const entry = libraryEntry({
    ...definition,
    taxonomyGroups: [
      {
        label: "Policy evaluation",
        taxonomy: { domains: ["robotics"], interfaces: ["physical-control"] },
      },
    ],
  });
  const html = renderToStaticMarkup(<SupportedCard entry={entry} open toggle={vi.fn()} />);
  expect(html).toContain("VLA models are evaluated policies");
  expect(html).toContain("model version, checkpoint, and suite");
});
