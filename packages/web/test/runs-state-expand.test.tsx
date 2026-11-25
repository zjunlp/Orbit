import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { Run } from "../src/lib/api.ts";

vi.mock("../src/lib/router.ts", () => ({
  useLocation: () => ({ query: new URLSearchParams("state=failed"), path: "/runs" }),
  setQuery: vi.fn(),
  navigate: vi.fn(),
  onLinkClick: vi.fn(),
}));
vi.mock("../src/lib/use.ts", () => ({
  useAsync: () => ({ data: [], loading: false, error: null, reload: vi.fn() }),
}));

const spec = {
  name: "swe-lite__astropy-12907",
  group: "qa/demo",
  command: ["true"],
  image: "python:3.12",
  params: {},
  tags: {},
  resources: { cpus: 2, memGB: 4, gpus: 1 },
};

const runs = ["a043ec", "a1f4c2"].map(
  (id) =>
    ({
      id,
      state: "failed",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
      spec,
    }) as unknown as Run,
);

vi.mock("../src/lib/runs-store.ts", () => ({
  useRuns: () => runs,
  useRunsState: () => ({ loaded: true, error: null }),
}));

afterEach(() => vi.unstubAllGlobals());

it("expands matching groups when a state filter is active", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null });
  const { Runs } = await import("../src/pages/Runs.tsx");
  const html = renderToStaticMarkup(<Runs />);
  // The group row alone is not an answer to "show me the failed runs".
  expect(html).toContain('href="/runs/a043ec"');
  expect(html).toContain('href="/runs/a1f4c2"');
});
