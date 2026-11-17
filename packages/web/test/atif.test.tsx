import assert from "node:assert/strict";
import { AtifTrajectory, Run } from "@zjunlp/orbit/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import {
  linkedRecords,
  stepInterval,
  trajectoryMediaUrl,
  trajectoryTree,
} from "../src/lib/atif.ts";
import { AtifContent, AtifViewer } from "../src/pages/run/Trajectory.tsx";

const location = vi.hoisted(() => ({ query: new URLSearchParams() }));
vi.mock("../src/lib/router.ts", () => ({
  useLocation: () => location,
  setQuery: vi.fn(),
  onLinkClick: vi.fn(),
}));
const run = Run.parse({
  id: "fixture",
  spec: { backend: "process", command: ["true"] },
  state: "succeeded",
  reason: null,
  exitCode: 0,
  node: "test",
  image: null,
  containerId: null,
  lease: null,
  code: null,
  cleanup: "done",
  note: "",
  createdAt: "2026-11-16T00:00:00Z",
  startedAt: null,
  endedAt: null,
});
const trace = () =>
  AtifTrajectory.parse({
    schema_version: "ATIF-v1.7",
    trajectory_id: "root",
    agent: { name: "codex", version: "test" },
    steps: [
      { step_id: 1, source: "user", message: "Solve the task", timestamp: "2026-11-16T00:00:00Z" },
      {
        step_id: 2,
        source: "agent",
        message: "Testing tools",
        reasoning_content: "Private unavailable reasoning",
        extra: {
          orbit: { reasoning: "opaque", checkpoint: { id: "cp", level: "step" } },
          context_management: { strategy: "summary" },
        },
        metrics: { prompt_tokens: 0, completion_tokens: 6 },
        tool_calls: [
          { tool_call_id: "a", function_name: "first", arguments: {} },
          { tool_call_id: "b", function_name: "second", arguments: {} },
        ],
        observation: {
          results: [
            {
              source_call_id: "b",
              content: "Second result",
              subagent_trajectory_ref: [{ trajectory_path: "external.json" }],
            },
            {
              source_call_id: "a",
              content: "First result",
              subagent_trajectory_ref: [{ trajectory_id: "child" }],
            },
          ],
        },
        timestamp: "2026-11-16T00:00:02Z",
      },
    ],
    subagent_trajectories: [
      {
        schema_version: "ATIF-v1.7",
        trajectory_id: "child",
        agent: { name: "worker", version: "test" },
        steps: [{ step_id: 1, source: "agent", message: "Child evidence" }],
      },
    ],
  });
beforeEach(() => {
  location.query = new URLSearchParams();
});
it("reads one ATIF step, pairs each result by call ID and preserves unknown usage", () => {
  location.query.set("step", "2");
  const html = renderToStaticMarkup(<AtifViewer root={trace()} run={run} compact />);
  expect(html).toContain("First result");
  expect(html).toContain("Second result");
  expect(html.indexOf("first <")).toBeLessThan(html.indexOf("First result"));
  expect(html).toContain("Input: 0");
  expect(html).toContain("Cached: not recorded");
  expect(html).toContain("Context compression");
  expect(html).toContain("Checkpoint");
  expect(html).toContain("Open sub-Agent");
  expect(html).toContain("Sub-Agent evidence unavailable · external.json");
  expect(html).not.toContain("Private unavailable reasoning");
});
it("keeps nested branch and side-by-side step locations separate", () => {
  location.query = new URLSearchParams("parent-agent=0&parent-step=1&child-step=2");
  const html = renderToStaticMarkup(
    <AtifViewer root={trace()} run={run} prefix="parent-" compact />,
  );
  expect(html).toContain("Child evidence");
  expect(html).not.toContain("First result");
  expect(trajectoryTree(trace()).map((t) => t.path)).toEqual(["", "0"]);
  location.query.set("parent-agent", "999");
  expect(
    renderToStaticMarkup(<AtifViewer root={trace()} run={run} prefix="parent-" compact />),
  ).toContain("branch unavailable");
});
it("bounds the rendered step list for thousands of steps", () => {
  const root = trace();
  root.steps = Array.from({ length: 5000 }, (_, i) => ({
    step_id: i + 1,
    source: "agent",
    message: `Message ${i + 1}`,
  }));
  location.query.set("step", "4999");
  const html = renderToStaticMarkup(<AtifViewer root={root} run={run} compact />);
  expect(html).toContain("Message 4999");
  expect((html.match(/class="atif-step(?: on)?"/g) ?? []).length).toBeLessThan(40);
});
it("only requests safe local trajectory media, never remote or traversal paths", () => {
  for (const path of [
    "https://example.com/image.png",
    "../auth.json",
    "media/../../auth",
    "/image.png",
    "media/a.svg",
  ])
    expect(trajectoryMediaUrl("run", path)).toBeNull();
  const path = `media/${"a".repeat(64)}.png`;
  expect(trajectoryMediaUrl("run/x", path)).toContain("run%2Fx/trajectory/files/media/");
  const html = renderToStaticMarkup(
    <AtifContent
      run="run"
      content={[
        {
          type: "image",
          source: { path: "https://example.com/image.png", media_type: "image/png" },
        },
        { type: "text", text: "<script>alert(1)</script>" },
      ]}
    />,
  );
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<script>");
  expect(html).toContain("Media unavailable");
});
it("aligns only explicit step references and labels time gaps accurately", () => {
  expect(linkedRecords([{}, { sessionStepIds: [2] }, { sessionStepIds: [3, 2] }], 2)).toEqual([
    1, 2,
  ]);
  const steps = trace().steps;
  assert(steps[0] && steps[1]);
  expect(stepInterval(steps[0], steps[1])).toBe(2);
  expect(stepInterval(steps[1], steps[0])).toBeNull();
  expect(stepInterval(steps[1])).toBeNull();
});
