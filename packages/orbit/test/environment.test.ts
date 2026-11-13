// Disposable MiniWoB, EFE MetaWorld+ and BFCL-format records; store, converters and handlers are real.
// HTTP transport and scheduler probing are explicit test doubles. No Agent or simulator is launched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importEfeTrajectory } from "../src/bench/trajectory.ts";
import { registerTrajectory } from "../src/cli/trajectory.ts";
import { OrbitClient } from "../src/client/index.ts";
import { orbitPaths } from "../src/config/paths.ts";
import {
  type AtifTrajectory,
  ConversationTrajectory,
  GuiTrajectory,
  Run,
} from "../src/contracts/index.ts";
import { type AppDeps, createApp } from "../src/daemon/app.ts";
import { RunService } from "../src/runs/service.ts";
import { convertCodexTrajectory } from "../src/sessions/codex.ts";
import { alignEnvironment } from "../src/sessions/environment.ts";
import { projectTranscript } from "../src/sessions/projection.ts";
import { trajectorySummary } from "../src/sessions/trajectory.ts";
import { Store } from "../src/store/index.ts";

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function agent(): AtifTrajectory {
  const t = convertCodexTrajectory(
    readFileSync(new URL("fixtures/atif/codex.jsonl", import.meta.url), "utf8"),
  ).trajectory;
  const step = t.steps[1];
  assert(step);
  step.tool_calls = [
    {
      tool_call_id: "call-bfcl",
      function_name: "mcp__bfcl__call_function",
      arguments: { name: "ls", arguments: { directory: "/" } },
    },
  ];
  step.observation = {
    results: [
      {
        source_call_id: "call-bfcl",
        content: JSON.stringify({
          content: [{ type: "text", text: JSON.stringify({ id: "gui-action", step: 1 }) }],
        }),
      },
    ],
  };
  return t;
}
const gui = () => ({
  version: 1,
  goal: "MiniWoB click-test",
  steps: [
    { step: 0, screenshot: "screenshots/0.png", action: null, reward: 0 },
    {
      step: 1,
      screenshot: "screenshots/1.png",
      action: "mouse_click(10, 20)",
      actionId: "gui-action",
      reward: 1,
    },
  ],
});
const conversation = () =>
  ConversationTrajectory.parse({
    version: 1,
    kind: "conversation",
    participants: [
      { id: "agent", role: "agent", label: "BFCL agent" },
      { id: "user", role: "user", label: "User" },
    ],
    turns: [
      {
        index: 0,
        events: [
          {
            type: "tool_call",
            id: "verifier-call",
            actor: "agent",
            name: "ls",
            arguments: { directory: "/" },
            result: [],
            status: "ok",
          },
        ],
      },
    ],
    verdict: { passed: true },
  });
function episode(t: AtifTrajectory) {
  const messages = projectTranscript(t).messages;
  const ts = Date.parse("2026-11-12T00:01:00Z") / 1000;
  return importEfeTrajectory({
    goal: "MetaWorld+ assembly",
    journal: JSON.stringify({ ev: "submit", call: 1, ts, control_steps: 1 }),
    final: { protocol: "eai-standard/2.1", tool: "mw_tool", control_steps: 1, finalized: true },
    actions: [[0, 0, 0, 0]],
    messages,
  });
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "orbit-environment-"));
  roots.push(home);
  const paths = orbitPaths({ ORBIT_HOME: home });
  const store = new Store(":memory:");
  stores.push(store);
  const runs = new RunService({ store, paths, probe: vi.fn() });
  const t = agent();
  const run = Run.parse({
    id: "solve",
    spec: { backend: "process", command: ["true"] },
    state: "succeeded",
    reason: null,
    exitCode: 0,
    node: "fixture",
    image: null,
    containerId: null,
    lease: null,
    code: null,
    cleanup: "done",
    note: "",
    createdAt: "2026-11-13T00:00:00Z",
    startedAt: null,
    endedAt: "2026-11-13T00:01:00Z",
    trajectory: trajectorySummary(t),
  });
  store.putRun(run);
  const dirs = runs.dirs(run.id);
  mkdirSync(join(dirs.orbit, "trajectory"), { recursive: true });
  mkdirSync(dirs.output, { recursive: true });
  writeFileSync(join(dirs.orbit, "trajectory/trajectory.json"), JSON.stringify(t));
  const app = createApp({ runs, token: "fixture", webDir: null } as AppDeps);
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => app.request(url, init));
  const c = new OrbitClient({ url: "http://orbit.test", token: "fixture", pid: 0 });
  return { home, store, runs, run, t, dirs, app, c };
}
describe("ATIF environment alignment", () => {
  it("links MiniWoB action IDs to their owning call step, not nearby text or timestamps", () => {
    const t = agent();
    const linked = alignEnvironment("gui", gui(), t, "solve");
    expect(linked.steps[1]?.sessionStepIds).toEqual([2]);
    expect(linked.completeness).toBe("complete");
    expect(linked.steps[0]?.sessionStepIds).toEqual([]);
    const last = t.steps[2];
    assert(last);
    last.tool_calls = structuredClone(t.steps[1]?.tool_calls);
    last.observation = structuredClone(t.steps[1]?.observation);
    expect(alignEnvironment("gui", gui(), t, "solve").steps[1]?.sessionStepIds).toEqual([]);
  });
  it("reads pretty-printed GUI results before display clipping and ignores copied context", () => {
    const t = agent();
    const step = t.steps[1];
    assert(step?.observation?.results[0]);
    step.observation.results[0].content = JSON.stringify(
      { padding: "x".repeat(5000), id: "gui-action", step: 1 },
      null,
      2,
    );
    expect(alignEnvironment("gui", gui(), t, "solve").steps[1]?.sessionStepIds).toEqual([2]);
    step.is_copied_context = true;
    expect(alignEnvironment("gui", gui(), t, "solve").steps[1]?.sessionStepIds).toEqual([]);
  });
  it("links unique conversation messages and leaves repeated text unlinked", () => {
    const t = agent();
    const step = t.steps[2];
    assert(step);
    step.message = "The conversation reply";
    const trace = conversation();
    const turn = trace.turns[0];
    assert(turn);
    turn.events = [{ type: "message", actor: "agent", text: "The conversation reply" }];
    expect(alignEnvironment("conversation", trace, t, "solve").turns[0]?.sessionStepIds).toEqual([
      3,
    ]);
    turn.events.push({ ...turn.events[0] } as (typeof turn.events)[number]);
    expect(alignEnvironment("conversation", trace, t, "solve").turns[0]?.sessionStepIds).toEqual(
      [],
    );
  });
  it("writes stable EFE step IDs and translates legacy zero-based message indexes", () => {
    const t = agent();
    const trace = episode(t);
    expect(trace.samples.at(-1)?.sessionStepIds).toContain(2);
    expect(trace.samples.at(-1)?.sessionMessageIndexes).toBeUndefined();
    trace.samples[0] = {
      ...trace.samples[0],
      sessionMessageIndexes: [1, 2, 9999],
      sessionStepIds: undefined,
    } as (typeof trace.samples)[number];
    const linked = alignEnvironment("episode", trace, t, "solve");
    expect(linked.samples[0]?.sessionStepIds).toEqual([2]);
    expect(linked.samples[0]?.sessionMessageIndexes).toEqual([1, 2, 9999]);
    trace.samples[0].sessionStepIds = [3];
    expect(alignEnvironment("episode", trace, t, "solve").samples[0]?.sessionStepIds).toEqual([3]);
  });
  it("links BFCL calls by exact ID or a unique wrapper signature, leaving repetitions unlinked", () => {
    const t = agent();
    const trace = conversation();
    expect(alignEnvironment("conversation", trace, t, "solve").turns[0]?.sessionStepIds).toEqual([
      2,
    ]);
    const event = trace.turns[0]?.events[0];
    assert(event?.type === "tool_call");
    event.id = "call-bfcl";
    event.arguments = { different: "payload" };
    expect(alignEnvironment("conversation", trace, t, "solve").turns[0]?.sessionStepIds).toEqual([
      2,
    ]);
    event.id = "verifier-call";
    event.arguments = { directory: "/" };
    trace.turns.push({
      ...trace.turns[0],
      index: 1,
      events: [{ ...event }],
    } as (typeof trace.turns)[number]);
    expect(
      alignEnvironment("conversation", trace, t, "solve").turns.map((turn) => turn.sessionStepIds),
    ).toEqual([[], []]);
    event.actor = "user";
    expect(alignEnvironment("conversation", trace, t, "solve").turns[0]?.sessionStepIds).toEqual(
      [],
    );
  });
  it("keeps environment-only, agent-only and damaged evidence distinct", () => {
    const t = agent();
    expect(t.extra?.orbit?.completeness).toBe("agent-only");
    for (const [kind, value] of [
      ["gui", gui()],
      ["episode", episode(t)],
      ["conversation", conversation()],
    ] as const)
      expect(alignEnvironment(kind, value, null, "solve").completeness).toBe("environment-only");
    assert(t.extra?.orbit);
    t.extra.orbit.completeness = "truncated";
    expect(alignEnvironment("gui", gui(), t, "solve").completeness).toBe("truncated");
  });
  it("serves three linked views through the real API/client and CLI, preserving raw evidence", async () => {
    const f = fixture();
    for (const [kind, value] of [
      ["gui", gui()],
      ["episode", episode(f.t)],
      ["conversation", conversation()],
    ] as const) {
      const path = `${kind}.json`;
      const original = JSON.stringify(value);
      writeFileSync(join(f.dirs.output, path), original);
      const linked = await f.c.environment(f.run.id, path, kind);
      expect(linked.completeness).toBe("complete");
      expect(linked.sessionRunId).toBe(f.run.id);
      const rows =
        "steps" in linked ? linked.steps : "samples" in linked ? linked.samples : linked.turns;
      expect(rows.flatMap((row) => row.sessionStepIds ?? [])).toContain(2);
      expect(readFileSync(join(f.dirs.output, path), "utf8")).toBe(original);
    }
    const print = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerTrajectory(program, async () => f.c);
    await program.parseAsync(
      ["trajectory", "environment", f.run.id, "gui.json", "--kind", "gui", "--json"],
      { from: "user" },
    );
    expect(JSON.parse(String(print.mock.calls.at(-1)?.[0])).steps[1].sessionStepIds).toEqual([2]);
  });
  it("uses Solve session references for Verify files, and forwards worker evidence", async () => {
    const f = fixture();
    const verify = { ...f.run, id: "verify", trajectory: null };
    f.store.putRun(verify);
    mkdirSync(f.runs.dirs(verify.id).output, { recursive: true });
    writeFileSync(
      join(f.runs.dirs(verify.id).output, "conversation.json"),
      JSON.stringify(conversation()),
    );
    expect(
      (await f.c.environment("verify", "conversation.json", "conversation", "solve")).turns[0]
        ?.sessionStepIds,
    ).toEqual([2]);
    const remote = { ...f.run, id: "remote", remote: true };
    f.store.putRun(remote);
    const cluster = {
      file: vi.fn(async () => new Response(JSON.stringify(gui()))),
      trajectory: vi.fn(async () => f.t),
    };
    const app = createApp({
      runs: f.runs,
      token: "fixture",
      webDir: null,
      cluster,
    } as unknown as AppDeps);
    const r = await app.request("/api/v1/runs/remote/environment?kind=gui&path=gui.json", {
      headers: { authorization: "Bearer fixture" },
    });
    expect(r.status).toBe(200);
    expect(GuiTrajectory.parse(await r.json()).steps[1]?.sessionStepIds).toEqual([2]);
    expect(cluster.file).toHaveBeenCalledWith(remote, "gui.json");
  });
  it("bounds and validates files and retains environment evidence when Agent conversion fails", async () => {
    const f = fixture();
    const request = (query: string) =>
      f.app.request(`/api/v1/runs/solve/environment?${query}`, {
        headers: { authorization: "Bearer fixture" },
      });
    expect((await request("path=missing.json&kind=gui")).status).toBe(404);
    writeFileSync(join(f.dirs.output, "invalid.json"), "{");
    expect((await request("path=invalid.json&kind=gui")).status).toBe(400);
    writeFileSync(join(f.dirs.output, "big.json"), " ".repeat(2 * 1024 * 1024 + 1));
    expect((await request("path=big.json&kind=gui")).status).toBe(413);
    symlinkSync(f.home, join(f.dirs.output, "escape"));
    expect((await request("path=escape/auth.json&kind=gui")).status).not.toBe(200);
    writeFileSync(join(f.dirs.output, "gui.json"), JSON.stringify(gui()));
    writeFileSync(join(f.dirs.orbit, "trajectory/trajectory.json"), "broken");
    const result = await f.c.environment("solve", "gui.json", "gui");
    expect(result.completeness).toBe("truncated");
    expect(result.steps).toHaveLength(2);
  });
});
