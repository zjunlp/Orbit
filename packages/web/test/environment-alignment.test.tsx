import { readFileSync } from "node:fs";
import { ConversationTrajectory, EpisodeTrajectory, GuiTrajectory } from "@zjunlp/orbit/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ConversationViewer } from "../src/pages/trial/Conversation.tsx";
import { EpisodeViewer } from "../src/pages/trial/Episode.tsx";
import { TrajectoryViewer } from "../src/pages/trial/Trajectory.tsx";

vi.mock("../src/lib/router.ts", () => ({
  useLocation: () => ({ query: new URLSearchParams("step=0&turn=0") }),
  setQuery: vi.fn(),
  onLinkClick: vi.fn(),
}));
// Canvas rendering is checked in the browser; this unit fixture checks sample selection.
vi.mock("../src/components/Chart.tsx", () => ({ PALETTE: ["#123456"], Chart: () => <div /> }));

it("uses the selected ATIF-linked GUI observation instead of the standalone URL index", () => {
  const trace = GuiTrajectory.parse({
    version: 1,
    goal: "Alignment fixture",
    steps: [
      { step: 0, action: null, screenshot: "before.png", reward: 0 },
      { step: 1, action: "click(4, 8)", screenshot: "after.png", reward: 1, sessionStepIds: [8] },
    ],
  });
  const html = renderToStaticMarkup(
    <TrajectoryViewer
      trajectory={trace}
      runId="r"
      files={new Set(["before.png", "after.png"])}
      listingTruncated={false}
      control={{ index: 1, select: vi.fn() }}
    />,
  );
  expect(html).toContain('src="/api/v1/runs/r/files/after.png"');
  expect(html).not.toContain('src="/api/v1/runs/r/files/before.png"');
});
it("shows one aligned conversation turn while retaining its verifier evidence", () => {
  const conversation = ConversationTrajectory.parse({
    version: 1,
    kind: "conversation",
    participants: [{ id: "u", role: "user", label: "User" }],
    turns: [
      { index: 0, events: [{ type: "message", actor: "u", text: "Unrelated first turn" }] },
      {
        index: 1,
        events: [{ type: "message", actor: "u", text: "Aligned second turn" }],
        check: { status: "failed", detail: "Recorded failure reason" },
      },
    ],
    verdict: { passed: false, failedTurn: 1 },
  });
  const html = renderToStaticMarkup(
    <ConversationViewer c={conversation} control={{ index: 1, select: vi.fn() }} />,
  );
  // The first turn may appear in navigation; its message body must not be rendered.
  expect(html).toContain("Aligned second turn");
  expect(html).not.toContain('id="turn-0"');
  expect(html).toContain('id="turn-1"');
  expect(html).toContain("Recorded failure reason");
});
it("positions episode evidence at the linked sample and disables autonomous playback", () => {
  const trace = EpisodeTrajectory.parse(
    JSON.parse(readFileSync(new URL("./fixtures/episode.json", import.meta.url), "utf8")),
  );
  trace.cameras = [];
  const html = renderToStaticMarkup(
    <EpisodeViewer
      trace={trace}
      runId="r"
      files={new Set()}
      control={{ index: 1, select: vi.fn() }}
    />,
  );
  expect(html).toMatch(/aria-label="Episode time"[^>]*value="1"/);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Play<\/button>/);
});
