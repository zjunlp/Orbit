import type { Run } from "@zjunlp/orbit/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { utcOffset } from "../src/lib/format.ts";
import { useAsync } from "../src/lib/use.ts";
import { EventsTab } from "../src/pages/run/Events.tsx";
import { LogsTab } from "../src/pages/run/Logs.tsx";

vi.mock("../src/lib/use.ts", () => ({ useAsync: vi.fn(), usePageVisible: () => true }));
vi.mock("../src/lib/router.ts", () => ({
  useLocation: () => ({ hash: "", query: new URLSearchParams() }),
  safeDecode: (s: string) => s,
  setQuery: vi.fn(),
  setHash: vi.fn(),
  onLinkClick: vi.fn(),
}));
vi.mock("../src/lib/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api.ts")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      logs: () => Promise.resolve({ offset: 0, next: 0, size: 0, eof: true, text: "", lines: 0 }),
    },
  };
});
beforeEach(() => vi.mocked(useAsync).mockReturnValue(loaded([])));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(useAsync).mockReset();
});

const run = {
  id: "fixture",
  state: "succeeded",
  cleanup: "done",
  createdAt: "2026-11-16T00:00:00Z",
} as unknown as Run;

const event = (seq: number, at: string) => ({ seq, at, kind: "state", message: "queued" });
// The hook returns a reload callback as well; the static markup tests never call it.
const loaded = (data: unknown) => ({ data, loading: false, error: null, reload: vi.fn() });

it("exposes the state of each log toolbar toggle to assistive tech", () => {
  vi.stubGlobal("localStorage", { getItem: () => null });
  const html = renderToStaticMarkup(<LogsTab run={run} />);
  // Six toggles: regex, case, only-matches, [orbit], wrap, follow. Follow starts on for a live
  // run only, so a finished run renders it off.
  expect(html.match(/aria-pressed=/g)?.length).toBe(6);
  expect(html).toContain('aria-pressed="false"');
  // The [orbit] toggle is the negation of hideSys, so it starts pressed.
  expect(html).toContain('aria-pressed="true"');
});

it("labels a local event time with its UTC offset", () => {
  const at = "2026-11-16T12:00:00Z";
  // getTimezoneOffset counts minutes west of UTC, the opposite sign of the label.
  const offset = vi
    .spyOn(Date.prototype, "getTimezoneOffset")
    .mockReturnValueOnce(-480)
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(330);
  expect(utcOffset(at)).toBe("UTC+8");
  expect(utcOffset(at)).toBe("UTC+0");
  expect(utcOffset(at)).toBe("UTC-5:30");
  offset.mockRestore();
  expect(utcOffset(null)).toBe("—");
});

it("shows the time zone once in the event header instead of every row", () => {
  const offset = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-480);
  vi.mocked(useAsync).mockReturnValue(
    loaded([event(1, "2026-11-16T12:00:00Z"), event(2, "2026-11-16T12:00:01Z")]),
  );
  const html = renderToStaticMarkup(<EventsTab run={run} />);
  // One label in the header keeps the column narrow enough for a 480px window.
  expect(html.match(/UTC\+8/g)?.length).toBe(1);
  expect(html).toContain("Time<span");
  // The raw timestamp stays reachable on hover.
  expect(html).toContain('title="2026-11-16T12:00:00Z"');
  offset.mockRestore();
});

it("falls back to a per-row label when the event times span two zones", () => {
  // Row 1 lands on the hour, row 2 one second later; the mock answers per Date instance.
  const offset = vi.spyOn(Date.prototype, "getTimezoneOffset").mockImplementation(function (
    this: Date,
  ) {
    return this.getUTCSeconds() === 0 ? 0 : -480;
  });
  vi.mocked(useAsync).mockReturnValue(
    loaded([event(1, "2026-11-16T12:00:00Z"), event(2, "2026-11-16T12:00:01Z")]),
  );
  const html = renderToStaticMarkup(<EventsTab run={run} />);
  expect(html).toContain("UTC+0");
  expect(html).toContain("UTC+8");
  offset.mockRestore();
});
