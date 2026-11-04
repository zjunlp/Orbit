import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseTrajectory,
  safeTrajectoryPath,
  trajectoryFrame,
  trajectoryStep,
} from "../src/lib/trajectory.ts";
import { TrajectoryViewer } from "../src/pages/trial/Trajectory.tsx";

const location = vi.hoisted(() => ({ query: new URLSearchParams() }));
vi.mock("../src/lib/router.ts", () => ({
  useLocation: () => location,
  setQuery: vi.fn(),
  onLinkClick: vi.fn(),
}));

const trace = {
  version: 1,
  goal: "Submit cobalt",
  steps: [
    { step: 0, screenshot: "screenshots/0000.png", action: null, reward: 0 },
    { step: 1, screenshot: "screenshots/0001.png", action: "mouse_click(120, 90)", reward: 0 },
    {
      step: 2,
      screenshot: "screenshots/0002.png",
      action: "keyboard_type('coblat')",
      reward: 0,
      truncated: true,
    },
  ],
  stopReason: "max_steps",
};
const parsed = () => parseTrajectory(JSON.stringify(trace));
beforeEach(() => {
  location.query = new URLSearchParams();
});

describe("saved GUI trajectory", () => {
  it("pairs an action with the previous observation before and its own observation after", () => {
    const t = parsed();
    expect(trajectoryFrame(t, 2, true)).toEqual({ action: t.steps[2], observation: t.steps[1] });
    expect(trajectoryFrame(t, 2, false)).toEqual({ action: t.steps[2], observation: t.steps[2] });
    expect(trajectoryFrame(t, 0, true)).toEqual({ action: t.steps[0], observation: t.steps[0] });
  });

  it("rejects truncated JSON, unsupported formats, missing rows and malformed values", () => {
    expect(() => parseTrajectory('{"version":1,"steps":[')).toThrow("incomplete");
    expect(() => parseTrajectory(JSON.stringify({ ...trace, version: 2 }))).toThrow(
      "not supported",
    );
    expect(() => parseTrajectory(JSON.stringify({ ...trace, steps: [] }))).toThrow(
      "initial observation",
    );
    expect(() =>
      parseTrajectory(JSON.stringify({ ...trace, steps: [trace.steps[0], trace.steps[2]] })),
    ).toThrow("step 1");
    for (const patch of [
      { action: null },
      { reward: "0" },
      { actionError: {} },
      { terminated: "false" },
    ]) {
      const steps = trace.steps.map((s) => (s.step === 1 ? { ...s, ...patch } : s));
      expect(() => parseTrajectory(JSON.stringify({ ...trace, steps }))).toThrow("Step 1");
    }
    expect(() =>
      parseTrajectory(
        JSON.stringify({ ...trace, steps: [{ ...trace.steps[0], action: "noop()" }] }),
      ),
    ).toThrow("Step 0");
  });

  it("only accepts screenshot paths inside a run", () => {
    for (const path of [
      "../x.png",
      "/x.png",
      "a/../x.png",
      "a\\x.png",
      "https://site/x.png",
      "a\0.png",
      "a//x.png",
    ]) {
      expect(safeTrajectoryPath(path)).toBe(false);
      expect(() =>
        parseTrajectory(
          JSON.stringify({ ...trace, steps: [{ ...trace.steps[0], screenshot: path }] }),
        ),
      ).toThrow("screenshot path");
    }
    expect(safeTrajectoryPath("screenshots/task image.png")).toBe(true);
  });

  it("bounds shared step links and does not accept negative or fractional indices", () => {
    expect(trajectoryStep(null, 3)).toBe(0);
    expect(trajectoryStep("2", 3)).toBe(2);
    expect(trajectoryStep("99", 3)).toBe(2);
    for (const value of ["-1", "1.2", "NaN", "Infinity", "99999999999999999"])
      expect(trajectoryStep(value, 3)).toBe(0);
  });

  it("loads only the selected screenshot and keeps current action alongside its before frame", () => {
    location.query = new URLSearchParams("step=2&frame=before");
    const t = parsed();
    const html = renderToStaticMarkup(
      <TrajectoryViewer
        trajectory={t}
        runId="fixture"
        files={new Set(t.steps.map((s) => s.screenshot))}
        listingTruncated={false}
      />,
    );
    expect(html).toContain('src="/api/v1/runs/fixture/files/screenshots/0001.png"');
    expect(html).not.toContain('src="/api/v1/runs/fixture/files/screenshots/0002.png"');
    expect(html).toContain("keyboard_type");
    expect(html).toContain("before action");
    expect(html).toContain("max_steps");
    expect(html).toContain("Truncated");
    expect(html).toContain('loading="lazy"');
  });

  it("keeps actions visible when an image is absent or the artifact listing is truncated", () => {
    location.query = new URLSearchParams("step=2");
    for (const listingTruncated of [true, false]) {
      const html = renderToStaticMarkup(
        <TrajectoryViewer
          trajectory={parsed()}
          runId="fixture"
          files={new Set()}
          listingTruncated={listingTruncated}
        />,
      );
      expect(html).toContain("Screenshot unavailable");
      expect(html).toContain("keyboard_type");
      expect(html).not.toContain("<img");
      expect(html).toContain(
        listingTruncated ? "listing is truncated" : "missing from the saved outputs",
      );
    }
  });
});

describe("GUI action overlays and Agent alignment", () => {
  it("draws coordinate actions and drag lines without evaluating action text", async () => {
    const { actionOverlay } = await import("../src/lib/gui-action.ts");
    const { ActionMarker } = await import("../src/pages/trial/Trajectory.tsx");
    expect(actionOverlay("mouse_click(12, 30)")).toEqual({ point: [12, 30] });
    expect(actionOverlay("mouse_click(12, 30, button='right')")).toEqual({ point: [12, 30] });
    expect(actionOverlay("mouse_drag_and_drop(12, 30, 45, 50)")).toEqual({
      point: [12, 30],
      end: [45, 50],
    });
    expect(actionOverlay("mouse_drag(12, 30, 45, 50)")).toEqual({});
    expect(actionOverlay("fill('13', 'hello, world')")).toEqual({ text: "hello, world" });
    expect(actionOverlay(String.raw`keyboard_type("it\'s")`)).toEqual({ text: "it's" });
    expect(actionOverlay("drag_and_drop('13', '14')")).toEqual({});
    expect(actionOverlay("__import__('os').system('bad')")).toEqual({});
    const html = renderToStaticMarkup(
      <ActionMarker action="mouse_drag_and_drop(12, 30, 45, 50)" width={160} height={200} />,
    );
    expect(html).toContain("Drag path");
    expect(html).toContain('x1="12"');
    expect(
      renderToStaticMarkup(<ActionMarker action="mouse_click(999, 30)" width={160} height={200} />),
    ).toBe("");
  });
  it("requires the returned step and excludes a preceding unrelated tool result", async () => {
    const { stepMessages } = await import("../src/lib/gui-action.ts");
    const t = parsed();
    if (t.steps[1]) t.steps[1].actionId = "operation";
    const unrelated = {
      at: null,
      role: "tool" as const,
      kind: "tool_result" as const,
      text: '{"id":"operation","step":2}',
    };
    const result = {
      ...unrelated,
      text: JSON.stringify({
        content: [{ type: "text", text: JSON.stringify({ id: "operation", step: 1 }) }],
      }),
    };
    expect(stepMessages(t, 1, [unrelated])).toEqual([]);
    expect(stepMessages(t, 1, [unrelated, result])).toEqual([result]);
  });
  it("shows only messages linked by the saved action id and preserves missing alignment", async () => {
    const { stepMessages } = await import("../src/lib/gui-action.ts");
    const t = parsed();
    if (t.steps[1]) t.steps[1].actionId = "unique-operation-id";
    const messages = [
      {
        at: null,
        role: "assistant" as const,
        kind: "thinking" as const,
        text: "Click the visible button",
      },
      {
        at: null,
        role: "assistant" as const,
        kind: "tool_call" as const,
        text: "orbit-computer act mouse_click(120,90)",
      },
      {
        at: null,
        role: "tool" as const,
        kind: "tool_result" as const,
        text: '{"id":"unique-operation-id","step":1}',
      },
      {
        at: null,
        role: "assistant" as const,
        kind: "thinking" as const,
        text: "Unrelated next action",
      },
    ];
    expect(stepMessages(t, 1, messages)).toEqual(messages.slice(0, 3));
    expect(stepMessages(t, 2, messages)).toEqual([]);
    if (t.steps[1]) t.steps[1].actionId = "1";
    expect(stepMessages(t, 1, messages)).toEqual([]);
    if (t.steps[1]) t.steps[1].actionId = "unique-operation-id";
    location.query = new URLSearchParams("step=1");
    const html = renderToStaticMarkup(
      <TrajectoryViewer
        trajectory={t}
        runId="fixture"
        files={new Set()}
        listingTruncated={false}
        messages={messages}
      />,
    );
    expect(html).toContain("Click the visible button");
    expect(html).not.toContain("Unrelated next action");
  });
});
