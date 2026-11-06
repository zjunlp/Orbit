import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { CatalogEntry, MethodLine } from "../src/lib/api.ts";
import { capLevel } from "../src/pages/Agents.tsx";
import { CoverageMatrix, distinct } from "../src/pages/bench/Catalog.tsx";
import { withLineage } from "../src/pages/bench/new-job.ts";
import { basisText, benchmarkSeries } from "../src/pages/Methods.tsx";
import { recentChanges } from "../src/pages/Overview.tsx";
import { deriveHref } from "../src/pages/Trial.tsx";

vi.mock("../src/lib/router.ts", () => ({
  useLocation: () => ({ query: new URLSearchParams(), path: "/" }),
  setQuery: vi.fn(),
  navigate: vi.fn(),
  onLinkClick: vi.fn(),
}));

const entry = (name: string, id: string, category: string, domains: string[], calibrated = false) =>
  ({
    benchmark: { name },
    identity: { id, name: id },
    identitySource: "adapter",
    domains,
    tags: [],
    capabilities: { category },
    listing: {},
    listingError: null,
    calibrations: calibrated ? [{ phase: "done", calibrated: true, checks: [] }] : [],
    methods: [],
  }) as unknown as CatalogEntry;

it("counts distinct benchmarks and lays them out by category and domain", () => {
  const es = [
    entry("asi-a", "asi-bench", "agent-workspace", ["science"]),
    entry("asi-b", "asi-bench", "agent-workspace", ["science"]),
    entry("efe", "efe", "agent-workspace", ["embodied"], true),
    entry("libero", "libero", "embodied-policy", ["embodied"]),
    entry("x", "x", "game", []),
  ];
  expect(distinct(es)).toBe(4);
  const html = renderToStaticMarkup(<CoverageMatrix entries={es} />);
  expect(html).toContain("C2 Agent workspace");
  expect(html).toContain("Unlabeled");
  // Two ASI registrations are one benchmark in the science cell.
  expect(html).toMatch(/1 benchmark\(s\), 0 passed sample calibration/);
  expect(html).toMatch(/1 benchmark\(s\), 1 passed sample calibration/);
});

it("tells declared, wired and shown capabilities apart", () => {
  expect(capLevel({ declared: false, wired: false, evidence: false })).toBe("none");
  expect(capLevel({ declared: true, wired: false, evidence: false })).toBe("declared");
  expect(capLevel({ declared: true, wired: true, evidence: false })).toBe("wired");
  expect(capLevel({ declared: true, wired: true, evidence: true })).toBe("evidence");
});

const rev = (revision: string, at: string, versus: object | null, extra: object = {}) => ({
  revision,
  basis: {
    agent: "codex",
    model: "gpt-6.1-sol",
    effort: "high",
    authKind: "login",
    cliVersion: "codex-cli 0.166.0",
    bundleDigest: "abcdef0123456789",
    entrypoint: null,
    config: null,
  },
  approximate: false,
  lineage: null,
  firstAt: at,
  results: [
    {
      benchmark: "bfcl",
      job: `j-${revision}`,
      method: "sol",
      at,
      tasks: 4,
      summary: { metrics: {} },
      versus,
    },
  ],
  ...extra,
});

it("describes revisions and orders their results and recent changes", () => {
  const line = {
    name: "sol",
    agents: ["codex"],
    revisions: [
      rev("bbbbbbbbbbbb", "2026-11-06T02:00:00Z", {
        revision: "aaaaaaaaaaaa",
        job: "j-a",
        method: "sol",
        pairedTasks: 4,
        diff: { mean: 25 },
        subset: false,
      }),
      rev("aaaaaaaaaaaa", "2026-11-06T01:00:00Z", null),
    ],
  } as unknown as MethodLine;
  expect(basisText(line.revisions[0] as never)).toBe(
    "codex · gpt-6.1-sol · high · cli 0.166.0 · bundle abcdef01",
  );
  expect(benchmarkSeries(line, "bfcl").map((p) => p.r.revision)).toEqual([
    "aaaaaaaaaaaa",
    "bbbbbbbbbbbb",
  ]);
  expect(recentChanges([line]).map((c) => c.r.revision)).toEqual(["bbbbbbbbbbbb"]);
});

it("attaches lineage to the methods under test only", () => {
  const spec = {
    benchmark: "b",
    tasks: ["t"],
    methods: [
      { name: "sol", agent: "codex", auth: "p" },
      { name: "empty", agent: "empty" },
    ],
  } as never;
  expect(withLineage(spec, { parent: "", note: "", informedBy: "" })).toBe(spec);
  const out = withLineage(spec, {
    parent: "0123456789ab",
    note: " retry ",
    informedBy: "j.00001, j.00002",
  });
  expect(out.lineage).toEqual({
    sol: { parent: "0123456789ab", note: "retry", informedBy: ["j.00001", "j.00002"] },
  });
  expect(() => withLineage(spec, { parent: "nope", note: "", informedBy: "" })).toThrow(
    /12 lowercase hex/,
  );
  expect(deriveHref("j", "0123456789ab", "j.00003", "sol")).toBe(
    "/bench/new?from=j&parent=0123456789ab&informedBy=j.00003&method=sol",
  );
});
