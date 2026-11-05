import { ConversationTrajectory } from "@zjunlp/orbit/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import {
  callSummary,
  deepParse,
  diffStates,
  flatten,
  parseConversation,
  parseResult,
  turnStats,
} from "../src/lib/conversation.ts";
import { failedTrial, neighbours } from "../src/pages/Trial.tsx";
import { ConversationViewer } from "../src/pages/trial/Conversation.tsx";

vi.mock("../src/lib/router.ts", () => ({
  useLocation: () => ({ query: new URLSearchParams() }),
  setQuery: vi.fn(),
  navigate: vi.fn(),
  onLinkClick: vi.fn(),
}));

// Invented two-turn conversation in the shape the BFCL verifier writes.
const conv = {
  version: 1,
  kind: "conversation",
  participants: [
    { id: "user", role: "user", label: "User" },
    { id: "agent", role: "agent", label: "codex" },
    { id: "environment", role: "environment", label: "GorillaFileSystem" },
  ],
  turns: [
    {
      index: 0,
      events: [
        { type: "message", actor: "user", text: "Create a directory named created." },
        {
          type: "tool_call",
          id: "t0c0",
          actor: "agent",
          name: "mkdir",
          arguments: { dir_name: "created" },
          status: "ok",
          result: "None",
        },
      ],
      check: { status: "passed" },
      state: {
        before: { fs: { d: {} } },
        after: { fs: { d: { created: {} } } },
        expected: { fs: { d: { created: {} } } },
      },
      reference: ["mkdir(dir_name='created')"],
    },
    {
      index: 1,
      events: [
        { type: "message", actor: "user", text: "List it." },
        {
          type: "tool_call",
          id: "t1c0",
          actor: "agent",
          name: "cat",
          arguments: {},
          status: "rejected",
          error: "Tool is unavailable: cat",
        },
      ],
      check: { status: "failed", detail: "Model instance does not match" },
      state: { before: { cwd: "/" }, after: { cwd: "/" }, expected: { cwd: "/created" } },
      reference: ["cd(folder='created')", "ls()"],
    },
  ],
  verdict: {
    passed: false,
    type: "multi_turn:instance_state_mismatch",
    message: "state differs",
    failedTurn: 1,
  },
  completeness: "complete",
  producer: "verifier",
  trust: "trusted",
};

it("matches the shared contract and parses saved conversations", () => {
  expect(ConversationTrajectory.safeParse(conv).success).toBe(true);
  const c = parseConversation(JSON.stringify(conv));
  expect(c.verdict.checks).toEqual([]);
  expect(() => parseConversation(JSON.stringify({ ...conv, kind: "episode" }))).toThrow();
});

it("flattens and diffs states into changed and mismatching paths", () => {
  expect(flatten({ a: { b: [1, { c: 2 }] }, e: {} })).toEqual({
    "a.b[0]": 1,
    "a.b[1].c": 2,
    e: {},
  });
  const rows = diffStates({ cwd: "/", n: 1 }, { cwd: "/", n: 2 }, { cwd: "/x", n: 2 });
  expect(rows).toEqual([
    { path: "cwd", before: "/", after: "/", expected: "/x", changed: false, mismatch: true },
    { path: "n", before: 1, after: 2, expected: 2, changed: true, mismatch: false },
  ]);
  expect(diffStates({ a: 1 }, { a: 1 })).toEqual([]);
});

it("summarizes calls, results and turns", () => {
  expect(callSummary({ name: "f", arguments: { "#0": 3, x: "y" } })).toBe("f(3, x=y)");
  expect(parseResult('{"a": 1}')).toEqual({ a: 1 });
  expect(parseResult("plain")).toBe("plain");
  expect(deepParse({ missing: ['{"a": [1]}', "x"] })).toEqual({ missing: [{ a: [1] }, "x"] });
  expect(turnStats(conv.turns[1] as never)).toMatchObject({ calls: 1, rejected: 1, errors: 0 });
});

it("renders the verdict, turn checks, call cards and the failing turn's state", () => {
  const html = renderToStaticMarkup(
    <ConversationViewer c={parseConversation(JSON.stringify(conv))} />,
  );
  expect(html).toContain("Task failed the benchmark&#x27;s checker");
  expect(html).toContain("First detected at turn 2");
  expect(html).toContain("mkdir(dir_name=created)");
  expect(html).toContain("Tool is unavailable: cat");
  // The failing turn is selected and its inspector opens on the state diff.
  expect(html).toContain("differ from expected");
  expect(html).toContain("/created");
});

it("finds neighbouring and failed trials in task, method, seed order", () => {
  const t = (id: string, task: string, score: number | null, evaluation = "valid") =>
    ({
      id,
      task,
      method: "m",
      seed: 1,
      state: "done",
      outcome: { evaluation, score, maxScore: 1 },
    }) as never;
  const trials = [t("c", "c", 1), t("a", "a", 1), t("b", "b", 0), t("d", "d", null, "invalid")];
  const n = neighbours(trials, trials[1] as never);
  expect(
    [n.prev, n.next, n.nextFailure].map((x) => (x as { id?: string } | undefined)?.id),
  ).toEqual([undefined, "b", "b"]);
  expect(failedTrial(trials[3] as never)).toBe(true);
  expect(neighbours(trials, trials[2] as never).nextFailure).toMatchObject({ id: "d" });
});
