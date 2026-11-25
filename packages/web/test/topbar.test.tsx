import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("../src/lib/router.ts", () => ({
  useLocation: () => ({ query: new URLSearchParams(), path: "/benchmarks" }),
  navigate: vi.fn(),
  setQuery: vi.fn(),
  onLinkClick: vi.fn(),
}));

const css = readFileSync(new URL("../src/components/topbar.css", import.meta.url), "utf8");
const { TopBar } = await import("../src/components/TopBar.tsx");

it("wraps the bar itself on narrow screens, not an opt-in page class", () => {
  // Narrow screens are a property of the bar: a page that forgot the class lost its breadcrumb.
  expect(css).toContain("@media (max-width: 700px)");
  expect(css).not.toContain("topbar-wrap");
  const narrow = css.slice(css.indexOf("@media (max-width: 700px)"));
  expect(narrow).toContain("flex-wrap: wrap");
  expect(narrow).toContain(".topbar .crumbs");
});

it("renders breadcrumbs the narrow-screen rules can shrink", () => {
  const html = renderToStaticMarkup(
    <TopBar crumbs={[{ label: "Benchmarks" }]}>
      <a className="btn sm" href="/bench/new">
        New evaluation
      </a>
    </TopBar>,
  );
  expect(html).toContain('<header class="topbar">');
  expect(html).toContain('<div class="crumbs">');
  expect(html).toContain('<span class="here ellipsis">Benchmarks</span>');
  expect(html).toContain("New evaluation");
});
