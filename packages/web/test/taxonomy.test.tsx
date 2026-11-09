import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { CatalogEntry } from "../src/lib/api.ts";
import {
  fieldValues,
  matchesLegacyDomain,
  matchesTaxonomy,
  readTaxonomyFilters,
} from "../src/lib/taxonomy.ts";
import { CoverageMatrix } from "../src/pages/bench/Catalog.tsx";

vi.mock("../src/lib/router.ts", () => ({
  useLocation: () => ({ query: new URLSearchParams() }),
  setQuery: vi.fn(),
  onLinkClick: vi.fn(),
}));

const mixed = {
  identity: { id: "mixed", name: "Mixed" },
  taxonomy: {
    domains: ["science", "software"],
    interfaces: ["terminal", "gui"],
    taskTypes: ["analysis", "repair"],
  },
  taxonomyGroups: [
    {
      taxonomy: { domains: ["science"], interfaces: ["terminal"], taskTypes: ["analysis"] },
      taskCount: 4,
    },
    {
      taxonomy: { domains: ["software"], interfaces: ["gui"], taskTypes: ["repair"] },
      taskCount: 3,
    },
  ],
} as CatalogEntry;

it("requires all selected fields to match the same task profile", () => {
  expect(matchesTaxonomy(mixed, { domains: ["science"], interfaces: ["gui"] })).toBe(false);
  expect(matchesTaxonomy(mixed, { domains: ["science", "software"], interfaces: ["gui"] })).toBe(
    true,
  );
  expect(matchesTaxonomy(mixed, { domains: ["science"], interfaces: ["terminal"] })).toBe(true);
});

it("keeps unknown, explicitly absent and no interactive feedback distinct", () => {
  expect(fieldValues({}, "participants")).toEqual(["unlabeled"]);
  expect(fieldValues({ participants: null }, "participants")).toEqual(["unlabeled"]);
  expect(fieldValues({ participants: [] }, "participants")).toEqual(["__none__"]);
  expect(fieldValues({ feedback: ["none"] }, "feedback")).toEqual(["none"]);
  expect(matchesTaxonomy({ ...mixed, taxonomyGroups: [] }, { domains: ["science"] })).toBe(false);
});

it("restores multi-select filters from URLs and preserves unrecognized values", () => {
  const filters = readTaxonomyFilters(
    new URLSearchParams("domains=science,software,science&interfaces=gui&targets=future-target"),
  );
  expect(filters.domains).toEqual(["science", "software"]);
  expect(filters.targets).toEqual(["future-target"]);
  expect(matchesTaxonomy(mixed, filters)).toBe(false);
  expect(readTaxonomyFilters(new URLSearchParams("domain=science")).domains).toEqual([]);
  expect(matchesLegacyDomain({ ...mixed, domains: ["embodied"] }, "embodied")).toBe(true);
});

it("does not create matrix cells from labels on different task profiles", () => {
  const html = renderToStaticMarkup(<CoverageMatrix entries={[mixed]} />);
  expect(html.match(/1 benchmark\(s\) with matching tasks/g)).toHaveLength(2);
  const filtered = renderToStaticMarkup(
    <CoverageMatrix entries={[mixed]} filters={{ interfaces: ["gui"] }} />,
  );
  expect(filtered).toContain("Software engineering");
  expect(filtered).not.toContain("Natural science");
  expect(filtered).toContain("Repair");
  expect(filtered).not.toContain("Analysis &amp; diagnosis");
});

it("keeps active axis filters when counting a matrix cell", () => {
  const entry = {
    ...mixed,
    taxonomyGroups: [
      { taxonomy: { domains: ["science", "software"], taskTypes: ["repair"] }, taskCount: 1 },
      { taxonomy: { domains: ["science"], taskTypes: ["repair", "analysis"] }, taskCount: 1 },
      { taxonomy: { domains: ["software"], taskTypes: ["analysis"] }, taskCount: 1 },
    ],
  } as CatalogEntry;
  const html = renderToStaticMarkup(
    <CoverageMatrix entries={[entry]} filters={{ domains: ["science"], taskTypes: ["repair"] }} />,
  );
  expect(html.match(/1 benchmark\(s\) with matching tasks/g)).toHaveLength(3);
});
