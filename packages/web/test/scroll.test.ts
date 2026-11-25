import type { EffectCallback } from "react";
import { afterEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  effect: undefined as EffectCallback | undefined,
}));

vi.mock("react", () => ({
  useRef: () => hooks.refs.shift(),
  useEffect: (effect: EffectCallback) => {
    hooks.effect = effect;
  },
}));

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

it("waits for loaded rows before spending the scroll restoration retries", async () => {
  let scrollTop = 0;
  let loaded = false;
  const element = {
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value: number) {
      scrollTop = loaded ? value : 0;
    },
  };
  const list = { current: element };
  const done = { current: false };
  const frames: (() => void)[] = [];
  vi.stubGlobal("sessionStorage", { getItem: () => "320" });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const { useScrollRestore } = await import("../src/lib/scroll.ts");
  const render = (ready: boolean) => {
    hooks.refs = [list, done];
    useScrollRestore("runs", ready);
    return hooks.effect?.();
  };

  render(false);
  // Model a slow initial fetch, longer than the restoration retry budget.
  for (let frame = 0; frame < 120; frame++) frames.shift()?.();
  expect(element.scrollTop).toBe(0);
  loaded = true;
  const cleanup = render(true);
  expect(element.scrollTop).toBe(320);
  if (typeof cleanup === "function") cleanup();
});
