import { readFileSync } from "node:fs";
import { EpisodeTrajectory } from "@zjunlp/orbit/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { episodeVideoTime, parseEpisode, sampleAt } from "../src/lib/episode.ts";
import { EpisodeViewer } from "../src/pages/trial/Episode.tsx";

vi.mock("../src/lib/router.ts", () => ({ onLinkClick: vi.fn() }));
vi.mock("../src/components/Chart.tsx", () => ({
  PALETTE: ["#123456"],
  Chart: ({ series }: { series: { label: string }[] }) => (
    <div>
      {series.map((item) => (
        <span key={item.label}>{item.label}</span>
      ))}
    </div>
  ),
}));
const source = readFileSync(new URL("./fixtures/episode.json", import.meta.url), "utf8");
const fixture = () => JSON.parse(source);

describe("saved embodied episode", () => {
  it("accepts the same fixture as the shared contract and finds samples by time", () => {
    const trace = parseEpisode(source);
    expect(EpisodeTrajectory.parse(trace)).toEqual(trace);
    expect(sampleAt(trace, 0.1)).toBe(0);
    expect(sampleAt(trace, 0.2)).toBe(1);
    expect(sampleAt(trace, 10)).toBe(1);
    const video = {
      path: "replay.mp4",
      timeMap: [
        { time: 0, videoTime: 0 },
        { time: 0.025, videoTime: 0.04 },
        { time: 0.0375, videoTime: 0.08 },
      ],
    };
    expect(episodeVideoTime(video, 0.0375)).toBe(0.08);
    expect(episodeVideoTime(video, 0.03)).toBe(0.04);
  });
  it("rejects unsafe media, bad vectors and reversed time in both validators", () => {
    const cases = [
      (t: ReturnType<typeof fixture>) => {
        t.cameras[0].frames = [];
      },
      (t: ReturnType<typeof fixture>) => {
        t.cameras[1].frames = [];
      },
      (t: ReturnType<typeof fixture>) => {
        t.trust = ["trusted"];
      },
      (t: ReturnType<typeof fixture>) => {
        t.completeness = "fake";
      },
      (t: ReturnType<typeof fixture>) => {
        t.samples[0].sessionMessageIndexes = [-1];
      },
      (t: ReturnType<typeof fixture>) => {
        t.cameras[1].video.timeMap = [{ time: 0, videoTime: -1 }];
      },
      (t: ReturnType<typeof fixture>) => {
        t.cameras[0].frames[0].path = "../escape.png";
      },
      (t: ReturnType<typeof fixture>) => {
        t.cameras[1].video.path = "https://example.org/video.mp4";
      },
      (t: ReturnType<typeof fixture>) => {
        t.samples[1].time = 0;
      },
      (t: ReturnType<typeof fixture>) => {
        t.samples[0].proprio = [1];
      },
      (t: ReturnType<typeof fixture>) => {
        t.chunks[0].end = -1;
      },
      (t: ReturnType<typeof fixture>) => {
        t.chunks[0].inferSeconds = -1;
      },
      (t: ReturnType<typeof fixture>) => {
        t.mediaPhase = "other";
      },
      (t: ReturnType<typeof fixture>) => {
        t.samples[0].late = "false";
      },
    ];
    for (const mutate of cases) {
      const trace = fixture();
      mutate(trace);
      expect(() => EpisodeTrajectory.parse(trace)).toThrow();
      expect(() => parseEpisode(JSON.stringify(trace))).toThrow();
    }
  });
  it("renders synchronized cameras, chunk boundaries, reward and live timing markers", () => {
    const trace = parseEpisode(source);
    const html = renderToStaticMarkup(
      <EpisodeViewer
        trace={trace}
        runId="fixture"
        files={new Set(["camera/front0.png", "camera/wrist.mp4"])}
      />,
    );
    for (const label of [
      "front",
      "wrist",
      "grasp",
      "Late action",
      "Stall",
      "Reward 0",
      "State · joint 1",
      "Action · gripper",
      "trusted",
    ])
      expect(html).toContain(label);
    expect(html).toContain('src="/api/v1/runs/fixture/files/camera/front0.png"');
    expect(html).not.toContain('src="/api/v1/runs/fixture/files/camera/front1.png"');
    expect(html).toContain('aria-label="Episode time"');
    expect(html).toContain("Loading saved video");
  });
  it("renders completeness and the referenced Agent messages", () => {
    const trace = parseEpisode(source);
    trace.completeness = "environment-only";
    if (trace.samples[0]) trace.samples[0].sessionMessageIndexes = [1];
    const html = renderToStaticMarkup(
      <EpisodeViewer
        trace={trace}
        runId="fixture"
        files={new Set()}
        messages={[
          { at: null, role: "assistant", kind: "text", text: "Unrelated" },
          {
            at: null,
            role: "assistant",
            kind: "tool_call",
            name: "Bash",
            text: "Inspect the robot",
          },
        ]}
      />,
    );
    expect(html).toContain("Environment only");
    expect(html).toContain("Inspect the robot");
    expect(html).not.toContain("Unrelated");
  });
  it("shows recorded inference time and resolves the camera against the Solve run", () => {
    const raw = fixture();
    raw.mediaPhase = "solve";
    raw.frameBeforeAction = true;
    raw.chunks[0].inferSeconds = 0.28;
    const trace = parseEpisode(JSON.stringify(raw));
    expect(EpisodeTrajectory.parse(trace)).toEqual(trace);
    const html = renderToStaticMarkup(
      <EpisodeViewer
        trace={trace}
        runId="verify-fixture"
        mediaRunId="solve-fixture"
        files={new Set(["camera/front0.png"])}
      />,
    );
    expect(html).toContain("inference 0.28s");
    expect(html).toContain("frame before the action");
    expect(html).toContain('src="/api/v1/runs/solve-fixture/files/camera/front0.png"');
  });
  it("keeps the timeline available when camera artifacts are absent", () => {
    const html = renderToStaticMarkup(
      <EpisodeViewer trace={parseEpisode(source)} runId="fixture" files={new Set()} />,
    );
    expect(html).toContain("Camera media unavailable");
    expect(html).toContain("Action chunks");
  });
});
