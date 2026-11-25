import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { Run } from "../src/lib/api.ts";

vi.mock("../src/lib/router.ts", () => ({
  useLocation: () => ({ query: new URLSearchParams(), path: "/runs" }),
  setQuery: vi.fn(),
  navigate: vi.fn(),
  onLinkClick: vi.fn(),
}));
vi.mock("../src/lib/use.ts", () => ({
  useAsync: () => ({ data: [], loading: false, error: null, reload: vi.fn() }),
}));

const run = {
  id: "r1",
  state: "succeeded",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:01.000Z",
  endedAt: "2026-01-01T00:01:00.000Z",
  folder: "",
  spec: {
    name: "fixture",
    group: "",
    command: ["true"],
    image: "python:3.12",
    params: { seed: "1" },
    tags: {},
    resources: { cpus: 2, memGB: 4, gpus: 1 },
  },
} as unknown as Run;

vi.mock("../src/lib/runs-store.ts", () => ({
  useRuns: () => [run],
  useRunsState: () => ({ loaded: true, error: null }),
}));

afterEach(() => vi.unstubAllGlobals());

it("pins the run list to fixed columns so it cannot overflow its container", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null });
  const { Runs } = await import("../src/pages/Runs.tsx");
  const html = renderToStaticMarkup(<Runs />);
  expect(html).toContain('class="table runs-table"');
  const head = html.slice(html.indexOf("<colgroup>"), html.indexOf("</colgroup>"));
  expect(head.match(/<col[\s/>]/g)).toHaveLength(9);
  expect(html).not.toContain("max-width:440");
});

it("sizes the run list columns from the stylesheet so a narrow container can drop them", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const start = css.indexOf("/* ---- run list table ----");
  const block = css.slice(start, css.indexOf("/* ---- folders ---- */", start));
  // Column widths must not live in the colgroup, or a container query could not override them.
  expect(block).toContain(".runs-table col:nth-child(9)");
  expect(block).toContain("table-layout: fixed");
  expect(block).not.toContain("940px");
  // Dropped columns keep their cells in the layout so spanning rows stay aligned with the header.
  expect(block).toMatch(/\(max-width: 939px\)[\s\S]*?nth-child\(6\)[\s\S]*?width: 0;/);
  expect(block).toContain("visibility: hidden");
});
