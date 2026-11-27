import type { SupportedBenchmark } from "@zjunlp/orbit/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { BenchmarkComparison } from "../src/pages/bench/BenchmarkComparison.tsx";
import {
  comparisonProfile,
  readComparison,
  toggleComparison,
} from "../src/pages/bench/comparison-model.ts";

const state = vi.hoisted(() => ({ query: "" }));
vi.mock("../src/lib/router.ts", () => ({
  useLocation: () => ({ query: new URLSearchParams(state.query) }),
  setQuery: vi.fn(),
  onLinkClick: vi.fn(),
}));
const fixture = (id: string): SupportedBenchmark => ({
  id,
  name: `Fixture ${id}`,
  description: `Synthetic description ${id}`,
  taxonomyGroups: [
    {
      label: "Science terminal protocol",
      taxonomy: { domains: ["science"], interfaces: ["terminal"] },
    },
    { label: "Software GUI protocol", taxonomy: { domains: ["software"], interfaces: ["gui"] } },
  ],
  integrations: [
    { name: "Synthetic SDK", url: "https://example.test/scope", scope: "Bounded fixture scope" },
  ],
  suites: ["Synthetic suite"],
  verification: {
    detail: "Synthetic fixture; no real environment checks.",
    url: "https://example.test/facts",
  },
  registrationNames: id === "a" ? ["fixture-local"] : [],
});

it("normalizes duplicate, blank, unknown and excessive URL selections in stable order", () => {
  const entries = ["a", "b", "c", "d", "e"].map(fixture);
  const selection = readComparison(" unknown,a,a, ,b,c,d,e ", entries);
  expect(selection.entries.map((entry) => entry.id)).toEqual(["a", "b", "c", "d"]);
  expect(selection.unknown).toEqual(["unknown"]);
  expect(selection.overflow).toBe(1);
  expect(readComparison(null, entries).entries).toEqual([]);
  expect(toggleComparison(["a", "b", "c", "d"], "e")).toEqual(["a", "b", "c", "d"]);
  expect(toggleComparison(["a", "b", "c", "d"], "b")).toEqual(["a", "c", "d"]);
  expect(toggleComparison(["a"], "b")).toEqual(["a", "b"]);
});

it("defaults to a single matching profile and validates URL profile indices", () => {
  const entry = fixture("a");
  expect(comparisonProfile(entry, null, { interfaces: ["gui"] })).toBe(1);
  expect(comparisonProfile(entry, "0", { interfaces: ["gui"] })).toBe(0);
  for (const value of ["99", "-1", "NaN", "", "0.5"]) {
    expect(comparisonProfile(entry, value, { interfaces: ["gui"] })).toBe(1);
  }
});

it("compares protocol-specific classification, scopes and setup facts without a union", () => {
  state.query = "compareProfile.a=1&compareProfile.b=1";
  const html = renderToStaticMarkup(
    <BenchmarkComparison entries={[fixture("a"), fixture("b")]} filters={{}} />,
  );
  expect(html).toContain("Software engineering");
  expect(html).toContain("GUI interaction");
  expect(html).not.toContain("Natural science</span>");
  expect(html).not.toContain("Terminal &amp; code execution</span>");
  expect(html).toContain("Bounded fixture scope");
  expect(html).toContain('href="https://example.test/facts"');
  expect(html).toContain("No local setup registered");
  expect(html).toContain("1 local setup registered");
  expect(html).toContain("does not establish readiness or calibration");
  expect(html).toContain("mode=resources&amp;family=a");
  expect(html).toContain("/bench/new?benchmark=fixture-local");
  state.query = "";
});

it("gives a browse action when an incomplete shared selection cannot form a comparison", () => {
  const html = renderToStaticMarkup(<BenchmarkComparison entries={[fixture("a")]} filters={{}} />);
  expect(html).toContain("Select at least two benchmark families");
  expect(html).toContain("Browse benchmark cards");
  expect(html).not.toContain("<table");
});
