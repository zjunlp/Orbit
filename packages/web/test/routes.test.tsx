import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KNOWN_KINDS } from "../src/lib/review.ts";
import { readRunFile } from "../src/lib/run-file.ts";
import { matchRoute, PAGES, pageShortcuts, railActive } from "../src/routes.ts";

vi.mock("../src/lib/router.ts", () => ({
  useLocation: () => ({ query: new URLSearchParams(), path: "/" }),
  setQuery: vi.fn(),
  navigate: vi.fn(),
  onLinkClick: vi.fn(),
}));

afterEach(() => vi.unstubAllGlobals());

describe("page table", () => {
  it("matches every page, detail routes and trailing slashes; unknown paths match nothing", () => {
    for (const p of PAGES) expect(matchRoute(p.path)?.name).toBe(p.name);
    expect(matchRoute("/bench/")).toEqual({ name: "bench", params: [] });
    expect(matchRoute("/runs/r%2F1/")).toEqual({ name: "run", params: ["r%2F1"] });
    expect(matchRoute("/bench/new")?.name).toBe("benchNew");
    expect(matchRoute("/bench/compare")?.name).toBe("benchCompare");
    expect(matchRoute("/bench/j1")).toEqual({ name: "benchJob", params: ["j1"] });
    expect(matchRoute("/bench/j1/trials/t1")).toEqual({ name: "trial", params: ["j1", "t1"] });
    for (const path of ["/nope", "/runs/a/b", "/bench/j1/trials", "/settings/x"])
      expect(matchRoute(path)).toBeNull();
  });

  it("keeps shortcuts unique and lists every page in the help", () => {
    const keys = PAGES.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(PAGES.map((p) => p.path)).size).toBe(PAGES.length);
    const help = pageShortcuts().map(([k]) => k);
    expect(help.join(" · ").split(" · ")).toEqual(keys.map((k) => `g ${k}`));
  });

  it("highlights the rail entry that covers a detail page", () => {
    const page = (name: string) => PAGES.find((p) => p.name === name) as (typeof PAGES)[number];
    expect(railActive(page("runs"), "/runs/abc")).toBe(true);
    expect(railActive(page("runs"), "/compare")).toBe(true);
    expect(railActive(page("bench"), "/bench/j1/trials/t1")).toBe(true);
    expect(railActive(page("overview"), "/runs")).toBe(false);
    expect(railActive(page("benchmarks"), "/benchmarks/")).toBe(true);
  });
});

describe("run output files", () => {
  const respond = (status: number, body: string) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status })),
    );

  it("reads a file and names it in errors", async () => {
    respond(200, "hello");
    await expect(readRunFile("r", "a.txt", "the file")).resolves.toBe("hello");
    respond(404, "");
    await expect(readRunFile("r", "a.txt", "the trajectory")).rejects.toThrow(
      "Could not read the trajectory (404).",
    );
  });

  it("refuses a file that grew past the preview limit after it was listed", async () => {
    respond(200, "x".repeat(11));
    await expect(readRunFile("r", "a.txt", "the episode index", 10)).rejects.toThrow(
      "The episode index exceeds the preview limit.",
    );
  });
});

describe("review file views", () => {
  it("has a view for every known review kind", async () => {
    const { FILE_VIEWS } = await import("../src/pages/trial/Review.tsx");
    expect(Object.keys(FILE_VIEWS).sort()).toEqual([...KNOWN_KINDS].sort());
  });

  it("lists unknown review fields under Details", async () => {
    const { DetailsView } = await import("../src/pages/trial/Review.tsx");
    const html = renderToStaticMarkup(
      <DetailsView
        review={{ files: [], items: [], details: { reward: 1 }, rubric: "v2" } as never}
      />,
    );
    expect(html).toContain("reward");
    expect(html).toContain("rubric");
    expect(html).toContain("v2");
  });

  it("lists grouped evidence files and shows the selected one", async () => {
    const { EvidenceView } = await import("../src/pages/trial/Review.tsx");
    const files = [
      { label: "Native result", phase: "solve", path: "native.json", kind: "json" },
      { label: "Scorer log", phase: "verify", path: "log.txt" },
    ];
    const html = renderToStaticMarkup(
      <EvidenceView
        review={{ files, items: [], details: {} } as never}
        indexes={[0, 1]}
        selected={1}
        solve={undefined}
        verify={undefined}
      />,
    );
    expect(html).toContain('href="?tab=evidence&amp;file=0"');
    expect(html).toMatch(/class="on"[^>]*>Scorer log/);
    expect(html).toContain("verify · text");
    expect(html).toContain("No verify run");
  });
});
