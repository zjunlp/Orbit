import { describe, expect, it } from "vitest";
import {
  AdapterTasksResponse,
  BenchJob,
  BenchTaskList,
  GuiTrajectory,
} from "../src/contracts/index.ts";

describe("GUI review contracts", () => {
  const initial = { step: 0, screenshot: "screenshots/0000.png", action: null, reward: 0 };
  const next = {
    step: 1,
    screenshot: "screenshots/0001.png",
    action: "mouse_click(12, 34)",
    reward: 1,
  };
  const trajectory = { version: 1, goal: "Click the button", steps: [initial, next] };

  it("retains actions on their resulting observation and rejects ambiguous row order", () => {
    expect(GuiTrajectory.parse(trajectory).steps[1]).toEqual(next);
    for (const steps of [
      [],
      [next],
      [initial, { ...next, step: 2 }],
      [{ ...initial, action: "noop()" }],
      [initial, { ...next, action: null }],
    ])
      expect(GuiTrajectory.safeParse({ ...trajectory, steps }).success).toBe(false);
    expect(GuiTrajectory.safeParse({ ...trajectory, version: 2 }).success).toBe(false);
    expect(GuiTrajectory.safeParse({ ...trajectory, goal: "x".repeat(100_001) }).success).toBe(
      false,
    );
    for (const action of ["", " ", "\t\n"])
      expect(
        GuiTrajectory.safeParse({ ...trajectory, steps: [initial, { ...next, action }] }).success,
      ).toBe(false);
  });

  it.each([
    "/etc/passwd",
    "../other.png",
    "screenshots/../other.png",
    "screenshots\\other.png",
    "bad\0.png",
    "./screenshots/0000.png",
    "screenshots/./0000.png",
    "screenshots//0000.png",
    "https://example.com/0000.png",
    "data:image/png;base64,fixture",
    "bad\n.png",
    "bad\t.png",
  ])("rejects an unsafe screenshot path %j", (screenshot) => {
    expect(
      GuiTrajectory.safeParse({ ...trajectory, steps: [{ ...initial, screenshot }] }).success,
    ).toBe(false);
  });

  it("keeps old task replies and jobs readable without inventing capabilities or snapshots", () => {
    expect(AdapterTasksResponse.parse({ tasks: [] })).toEqual({ tasks: [], metrics: [] });
    expect(BenchTaskList.parse({ tasks: [] })).toEqual({ tasks: [], metrics: [] });
    const job = BenchJob.parse({
      id: "old",
      spec: { benchmark: "fixture", methods: [{ name: "empty", agent: "empty" }] },
      state: "done",
      createdAt: "2026-10-01",
      endedAt: "2026-10-01",
    });
    expect(job.benchmarkSnapshot).toBeUndefined();
    expect(job.capabilities).toBeUndefined();
  });
});
