import { afterAll, expect, it, vi } from "vitest";

vi.stubGlobal("window", { addEventListener: vi.fn() });
const { legacyHref } = await import("../src/lib/router.ts");
afterAll(() => vi.unstubAllGlobals());

it("preserves old Catalog search, expansion and evidence filters", () => {
  const target = legacyHref(
    "/bench",
    new URLSearchParams("tab=catalog&q=science&open=a&ptab=methods&cal=real"),
    "evidence",
  );
  const url = new URL(target ?? "", "http://orbit.local");
  expect(url.pathname).toBe("/benchmarks");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    q: "science",
    open: "a",
    ptab: "methods",
    ev: "no-real",
  });
  expect(url.hash).toBe("#evidence");
  expect(legacyHref("/bench", new URLSearchParams("tab=catalog&cal=passed"))).toBe(
    "/benchmarks?ev=calibrated",
  );
});

it("keeps the new home and evaluation list while restoring saved run views", () => {
  expect(legacyHref("/", new URLSearchParams())).toBeNull();
  expect(legacyHref("/bench", new URLSearchParams("q=experiment"))).toBeNull();
  expect(legacyHref("/", new URLSearchParams("folder=research%2Fscience&state=failed"))).toBe(
    "/runs?folder=research%2Fscience&state=failed",
  );
  expect(legacyHref("/agents/", new URLSearchParams("tab=compatibility"))).toBe(
    "/agents?tab=compatibility",
  );
  expect(legacyHref("/bench/compare/", new URLSearchParams("jobs=a,b"))).toBe(
    "/bench/compare?jobs=a%2Cb",
  );
});
