import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

it("remembers the scroll offset of every mounted list before the route changes", async () => {
  const store = new Map<string, string>();
  const lists = [
    { dataset: { scrollKey: "runs" }, scrollTop: 320 },
    { dataset: {}, scrollTop: 99 },
  ];
  vi.stubGlobal("document", { querySelectorAll: () => lists });
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  });
  const { rememberScroll } = await import("../src/lib/scroll.ts");
  rememberScroll();
  expect(Object.fromEntries(store)).toEqual({ "orbit.scroll:runs": "320" });
});
