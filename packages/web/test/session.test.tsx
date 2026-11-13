import { Run, type RunSessions } from "@zjunlp/orbit/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { SessionTab } from "../src/pages/run/Session.tsx";

const state = vi.hoisted(() => ({ data: null as RunSessions | null }));
vi.mock("../src/lib/use.ts", () => ({ useAsync: () => ({ data: state.data, error: null }) }));
vi.mock("../src/lib/runs-store.ts", () => ({ useRuns: () => [], useRunsState: () => ({}) }));
vi.mock("../src/lib/router.ts", () => ({ onLinkClick: vi.fn() }));

const run = Run.parse({
  id: "trajectory-test",
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
  createdAt: "2026-11-13T00:00:00Z",
  startedAt: null,
  endedAt: "2026-11-13T00:01:00Z",
});
it("renders the ATIF projection and its incomplete evidence notice", () => {
  state.data = {
    submitter: null,
    submitterError: null,
    agent: {
      harness: "codex",
      sessionId: "native",
      file: null,
      completeness: "truncated",
      messages: [{ role: "user", kind: "text", text: "Recovered trajectory message", at: null }],
    },
  };
  const html = renderToStaticMarkup(<SessionTab run={run} />);
  expect(html).toContain("Recovered trajectory message");
  expect(html).toContain("This session is incomplete");
});
it("distinguishes conversion failure from a run without Agent evidence", () => {
  state.data = {
    submitter: null,
    submitterError: null,
    agent: null,
    agentError: "Native session is unreadable",
  };
  const html = renderToStaticMarkup(<SessionTab run={run} />);
  expect(html).toContain("Agent trajectory unavailable");
  expect(html).toContain("Native session is unreadable");
  state.data = { ...state.data, agentError: null };
  expect(renderToStaticMarkup(<SessionTab run={run} />)).toContain("No agent session");
});
