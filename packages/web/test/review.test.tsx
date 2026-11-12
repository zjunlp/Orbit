import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  fileHref,
  fileLabel,
  isBlank,
  isReplay,
  itemState,
  resolveKind,
  reviewTabs,
} from "../src/lib/review.ts";
import { parseTestsReport } from "../src/lib/tests-report.ts";
import { Value } from "../src/pages/trial/parts.tsx";
import { RubricView } from "../src/pages/trial/Rubric.tsx";
import { TestsView } from "../src/pages/trial/Tests.tsx";

vi.mock("../src/lib/router.ts", () => ({
  useLocation: () => ({ query: new URLSearchParams() }),
  setQuery: vi.fn(),
  navigate: vi.fn(),
  onLinkClick: vi.fn(),
}));

const file = (path: string, kind?: string, label = path.slice(path.lastIndexOf("/") + 1)) => ({
  label,
  phase: "verify" as const,
  path,
  kind,
});
const ctrf = (tests: unknown[], extra: object = {}) =>
  JSON.stringify({ results: { tool: { name: "pytest" }, summary: {}, tests, ...extra } });

describe("test report (CTRF)", () => {
  it("puts failures first, counts every status and keeps the runner's own word", () => {
    const r = parseTestsReport(
      ctrf([
        { name: "a", status: "passed", duration: 12 },
        { name: "b", status: "failed", message: "boom", trace: "Traceback", retries: 2 },
        { name: "c", status: "xfailed", tags: ["slow", 3], file_path: "t/test_c.py" },
        { name: "d", status: "skipped", raw_status: "call_skipped" },
      ]),
    );
    expect(r.tests.map((t) => t.name)).toEqual(["b", "c", "d", "a"]);
    expect(r.counts).toEqual({ failed: 1, other: 1, pending: 0, skipped: 1, passed: 1 });
    expect(r.tests[0]).toMatchObject({ message: "boom", trace: "Traceback", retries: 2 });
    expect(r.tests[1]).toMatchObject({
      status: "other",
      rawStatus: "xfailed",
      tags: ["slow"],
      file: "t/test_c.py",
    });
    expect(r.tests[2]?.rawStatus).toBe("call_skipped");
    expect(r).toMatchObject({ tool: "pytest", durationMs: 12, omitted: 0 });
  });

  it("reads epoch seconds (pytest) and epoch milliseconds (CTRF) as the same durations", () => {
    const seconds = parseTestsReport(
      ctrf([{ name: "a", status: "passed", start: 1_760_000_000, duration: 0.25 }], {
        summary: { start: 1_760_000_000, stop: 1_760_000_002.5 },
      }),
    );
    expect(seconds.tests[0]?.durationMs).toBe(250);
    expect(seconds.durationMs).toBe(2500);
    const millis = parseTestsReport(
      ctrf([{ name: "a", status: "passed", duration: 250 }], {
        summary: { start: 1_760_000_000_000, stop: 1_760_000_002_500 },
      }),
    );
    expect(millis.tests[0]?.durationMs).toBe(250);
    expect(millis.durationMs).toBe(2500);
    expect(parseTestsReport(ctrf([{ name: "a", status: "passed" }])).durationMs).toBeNull();
  });

  it("refuses what is not a test report and bounds a long one", () => {
    expect(() => parseTestsReport("{")).toThrow("not valid JSON");
    expect(() => parseTestsReport('{"reward":1}')).toThrow("results.tests is missing");
    expect(() => parseTestsReport(ctrf([{ status: "passed" }]))).toThrow("without a name");
    const many = Array.from({ length: 2003 }, (_, i) => ({ name: `t${i}`, status: "passed" }));
    const r = parseTestsReport(ctrf(many));
    expect([r.tests.length, r.omitted, r.counts.passed]).toEqual([2000, 3, 2003]);
  });

  it("renders the summary, the failure with its trace open, and an all-passed report", () => {
    const html = renderToStaticMarkup(
      <TestsView
        report={parseTestsReport(
          ctrf([
            { name: "test_ok", status: "passed" },
            { name: "test_bad", status: "failed", message: "assert 1 == 2", trace: "E  assert" },
            { name: "test_worse", status: "failed", trace: "E  later" },
          ]),
        )}
      />,
    );
    expect(html).toContain("2 of 3 failed");
    expect(html).toContain("Failed 2");
    expect(html).toContain("assert 1 == 2");
    expect(html.match(/<details[^>]* open=""/g)).toHaveLength(1);
    expect(html.indexOf("test_bad")).toBeLessThan(html.indexOf("test_ok"));
    const passed = renderToStaticMarkup(
      <TestsView report={parseTestsReport(ctrf([{ name: "only", status: "passed" }]))} />,
    );
    expect(passed).toContain("All 1 passed");
    expect(passed).not.toContain('class="seg"');
    // A report that records no time writes zeros; those are not shown as durations.
    const untimed = renderToStaticMarkup(
      <TestsView
        report={parseTestsReport(
          ctrf([{ name: "only", status: "passed", duration: 0 }], {
            summary: { start: 0, stop: 0 },
          }),
        )}
      />,
    );
    expect(untimed).not.toMatch(/\dms|<1ms/);
    expect(renderToStaticMarkup(<TestsView report={parseTestsReport(ctrf([]))} />)).toContain(
      "The report lists no tests",
    );
  });
});

describe("trial tabs", () => {
  it("reads a file named ctrf.json as a test report, whatever it was declared as", () => {
    expect(resolveKind(file("collected/logs/verifier/ctrf.json")).kind).toBe("tests");
    expect(resolveKind(file("out/pytest-ctrf.json")).kind).toBe("tests");
    expect(resolveKind(file("out/spectrf.json")).kind).toBe("json");
    expect(resolveKind(file("ctrf.json", "json")).kind).toBe("json");
    expect(fileLabel(file("logs/ctrf.json"))).toBe("Tests");
    expect(fileLabel(file("logs/ctrf.json", undefined, "Hidden tests"))).toBe("Hidden tests");
    expect(fileLabel(file("logs/result.json"))).toBe("result.json");
  });

  it("opens on the replay and groups the remaining files as evidence", () => {
    const files = [
      file("native.json", "json"),
      file("trace.md", "markdown"),
      file("episode.json", "episode"),
      file("ctrf.json"),
      file("video.mp4"),
    ];
    expect(reviewTabs(files)).toEqual({ main: [2, 3], documents: [], rest: [0, 1, 4] });
    expect(fileHref(files, 1)).toBe("?tab=evidence&file=1");
    expect(fileHref(files, 2)).toBe("?tab=f2");
    expect(files.map(isReplay)).toEqual([false, false, true, false, false]);
  });

  it("keeps reports and videos as tabs without a replay, and a single leftover file", () => {
    const files = [file("result.json"), file("report.md"), file("run.mp4")];
    expect(reviewTabs(files)).toEqual({ main: [], documents: [1, 2], rest: [0] });
    expect(fileHref(files, 0)).toBe("?tab=f0");
    expect(reviewTabs([])).toEqual({ main: [], documents: [], rest: [] });
  });
});

describe("rubric", () => {
  it("tells what a criterion earned", () => {
    expect(itemState({ score: 2, maxScore: 2 })).toBe("full");
    expect(itemState({ score: 0.5, maxScore: 2 })).toBe("partial");
    expect(itemState({ score: 0, maxScore: 2 })).toBe("zero");
    expect(itemState({ score: 3 })).toBe("scored");
    expect(itemState({ score: null, maxScore: 1 })).toBe("none");
    expect(itemState({})).toBe("none");
  });

  it("renders counts, scores, reasoning and fields it does not know", () => {
    const html = renderToStaticMarkup(
      <RubricView
        items={[
          { criterion: "Loads the data", score: 1, maxScore: 1, type: "gate" },
          {
            criterion: "Plots the trend",
            score: 0.5,
            maxScore: 2,
            weight: 3,
            reasoning: "No axis",
          },
          { criterion: "Cites sources", score: 0, maxScore: 1, judge: "m1" } as never,
          { criterion: "Excluded", score: null },
        ]}
      />,
    );
    for (const text of [
      "4 criteria",
      "1 full marks",
      "1 partial",
      "1 no marks",
      "1 not scored",
      "total weight 3",
      "Lost points 2",
      "No axis",
      "judge: m1",
      "width:25%",
    ])
      expect(html).toContain(text);
    const one = renderToStaticMarkup(<RubricView items={[{ criterion: "Only", score: 1 }]} />);
    expect(one).toContain("1 criterion");
    expect(one).not.toContain("Lost points");
  });
});

describe("saved values", () => {
  it("leaves blank values out and shows objects as rows", () => {
    expect([undefined, null, "", [], {}].map(isBlank)).toEqual([true, true, true, true, true]);
    expect([0, false, "a", [0], { a: null }].map(isBlank)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    const html = renderToStaticMarkup(
      <Value
        value={{ cpus: 2, tags: ["a", "b"], empty: {}, nested: { deep: { x: [{ y: 1 }] } } }}
      />,
    );
    expect(html).toContain("<dt>cpus</dt>");
    expect(html).toContain("a, b");
    expect(html).not.toContain("empty");
    expect(html).toContain('<pre class="value-json">');
  });
});
