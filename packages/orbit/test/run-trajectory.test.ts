// Real store, converters and HTTP handlers; scheduler resources and HTTP transport are explicit fakes.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTrajectory } from "../src/cli/trajectory.ts";
import { OrbitClient } from "../src/client/index.ts";
import { NodeClient } from "../src/cluster/client.ts";
import type { ClusterService } from "../src/cluster/service.ts";
import { createWorkerApp } from "../src/cluster/worker.ts";
import { orbitPaths } from "../src/config/paths.ts";
import { type AtifSource, Run } from "../src/contracts/index.ts";
import { type AppDeps, createApp } from "../src/daemon/app.ts";
import { RunService } from "../src/runs/service.ts";
import { projectTranscript, runAgentFailure } from "../src/sessions/index.ts";
import { trajectoryTokens } from "../src/sessions/tokens.ts";
import { Store } from "../src/store/index.ts";

const homes: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = 0;
  for (const store of stores.splice(0)) store.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const native = (kind: string) =>
  readFileSync(new URL(`fixtures/atif/${kind}.jsonl`, import.meta.url), "utf8");
function fixture(id = "run-fixture") {
  const home = mkdtempSync(join(tmpdir(), "orbit-trajectory-"));
  homes.push(home);
  const paths = orbitPaths({ ORBIT_HOME: home });
  const store = new Store(":memory:");
  stores.push(store);
  const runs = new RunService({ store, paths, probe: vi.fn() });
  const run = Run.parse({
    id,
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
  });
  store.putRun(run);
  mkdirSync(runs.dirs(id).orbit, { recursive: true });
  const source = (kind = "codex", input = native(kind)) => {
    const dir = join(
      runs.dirs(id).agent,
      kind === "codex" ? "codex/sessions/2026/11/13" : "claude/projects/-fixture",
    );
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "session-fixture.jsonl");
    writeFileSync(file, input);
    return file;
  };
  const path = join(runs.dirs(id).orbit, "trajectory", "trajectory.json");
  return { home, paths, store, runs, run, source, path };
}
function client(f: ReturnType<typeof fixture>, cluster?: ClusterService) {
  const app = createApp({ runs: f.runs, token: "fixture", cluster, webDir: null } as AppDeps);
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => app.request(url, init));
  return { app, c: new OrbitClient({ url: "http://orbit.test", token: "fixture", pid: 0 }) };
}

describe("Run trajectories", () => {
  it.each(["codex", "claude"])(
    "backfills an old %s run and serves the same trajectory to CLI and session projection",
    async (kind) => {
      const f = fixture();
      f.source(kind);
      const { c } = client(f);
      const trajectory = await c.trajectory(f.run.id);
      assert(trajectory);
      expect(JSON.parse(readFileSync(f.path, "utf8"))).toEqual(trajectory);
      expect(f.runs.get(f.run.id)?.trajectory).toMatchObject({
        schema: "ATIF-v1.7",
        steps: trajectory?.steps.length,
      });
      expect(f.runs.get(f.run.id)?.tokens).toEqual(trajectoryTokens(trajectory));
      const saved = f.runs.get(f.run.id);
      assert(saved);
      f.store.putRun({ ...saved, tokens: null });
      await c.trajectory(f.run.id);
      expect(f.runs.get(f.run.id)?.tokens).toEqual(trajectoryTokens(trajectory));
      expect(statSync(f.path).mode & 0o777).toBe(0o600);
      const session = await c.session(f.run.id);
      expect(session.agent).toEqual(projectTranscript(trajectory));
      const print = vi.spyOn(console, "log").mockImplementation(() => {});
      const program = new Command();
      registerTrajectory(program, async () => c);
      await program.parseAsync(["trajectory", "show", f.run.id, "--json"], { from: "user" });
      expect(JSON.parse(String(print.mock.calls.at(-1)?.[0]))).toEqual(trajectory);
      expect(f.runs.events(f.run.id).filter((e) => e.kind === "trajectory")).toHaveLength(1);
    },
  );
  it("returns null without Agent evidence and leaves active runs unpersisted", async () => {
    const f = fixture();
    const { c } = client(f);
    expect(await c.trajectory(f.run.id)).toBeNull();
    expect(existsSync(f.path)).toBe(false);
    expect(f.runs.get(f.run.id)?.tokens).toBeNull();
    f.source();
    f.store.putRun({ ...f.run, state: "running", endedAt: null, cleanup: "pending" });
    expect(await c.trajectory(f.run.id)).not.toBeNull();
    expect(existsSync(f.path)).toBe(false);
    expect(f.runs.get(f.run.id)?.tokens).toBeNull();
    await expect(c.rebuildTrajectory(f.run.id)).rejects.toThrow(/finished run/);
  });
  it("serializes backfill and rebuild, preserves one old importer revision, and retains the original on failure", async () => {
    const f = fixture();
    const file = f.source();
    const { c } = client(f);
    await Promise.all([c.trajectory(f.run.id), c.trajectory(f.run.id)]);
    expect(f.runs.events(f.run.id).filter((e) => e.kind === "trajectory")).toHaveLength(1);
    const old = JSON.parse(readFileSync(f.path, "utf8"));
    old.extra.orbit.importer.version = 91;
    writeFileSync(f.path, JSON.stringify(old));
    await Promise.all([c.rebuildTrajectory(f.run.id), c.rebuildTrajectory(f.run.id)]);
    const backup = join(
      f.runs.dirs(f.run.id).orbit,
      "trajectory",
      "trajectory.codex-rollout-v91.json",
    );
    expect(JSON.parse(readFileSync(backup, "utf8"))).toEqual(old);
    const current = readFileSync(f.path, "utf8");
    writeFileSync(file, " ");
    await expect(c.rebuildTrajectory(f.run.id)).rejects.toThrow(/missing or empty/);
    expect(readFileSync(f.path, "utf8")).toBe(current);
    writeFileSync(file, native("codex"));
    rmSync(join(f.runs.dirs(f.run.id).orbit, "trajectory", "media"), { recursive: true });
    symlinkSync(f.home, join(f.runs.dirs(f.run.id).orbit, "trajectory", "media"));
    await expect(c.rebuildTrajectory(f.run.id)).rejects.toThrow(/unsafe trajectory/);
    expect(readFileSync(f.path, "utf8")).toBe(current);
    expect(f.runs.get(f.run.id)?.state).toBe("succeeded");
    expect(f.runs.events(f.run.id).some((e) => e.kind === "trajectory_error")).toBe(true);
  });
  it("materializes inline media and restricts media API paths", async () => {
    const f = fixture();
    f.source(
      "claude",
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
            },
          ],
        },
      }),
    );
    const { c, app } = client(f);
    const t = await c.trajectory(f.run.id);
    assert(t?.steps[0]);
    const content = t.steps[0].message;
    if (typeof content === "string") throw new Error("expected media");
    const path = content[0]?.source?.path;
    expect(path).toMatch(/^media\//);
    const response = await app.request(`/api/v1/runs/${f.run.id}/trajectory/files/${path}`, {
      headers: { authorization: "Bearer fixture" },
    });
    expect(await response.text()).toBe("hello");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    const outside = await app.request(
      `/api/v1/runs/${f.run.id}/trajectory/files/%2e%2e%2flog.txt`,
      { headers: { authorization: "Bearer fixture" } },
    );
    expect(outside.status).toBe(404);
    expect(JSON.stringify(t)).not.toContain("aGVsbG8=");
    const head = await app.request(`/api/v1/runs/${f.run.id}/trajectory/files/${path}`, {
      method: "HEAD",
      headers: { authorization: "Bearer fixture" },
    });
    expect(head.headers.get("content-length")).toBe("5");
    expect(await head.text()).toBe("");
    const media = join(f.runs.dirs(f.run.id).orbit, "trajectory", "media");
    rmSync(media, { recursive: true });
    symlinkSync(f.home, media);
    assert(path);
    writeFileSync(join(f.home, path.split("/")[1] as string), "outside the Run");
    const escaped = await app.request(`/api/v1/runs/${f.run.id}/trajectory/files/${path}`, {
      headers: { authorization: "Bearer fixture" },
    });
    expect(escaped.status).toBe(404);
  });
  it("redacts both stored and API trajectories while retaining native evidence", async () => {
    const f = fixture();
    const secret = "fixture-credential-not-real";
    const file = f.source("claude", JSON.stringify({ type: "user", message: { content: secret } }));
    vi.spyOn(f.runs, "redactor").mockReturnValue({
      apply: (s: string) => s.replaceAll(secret, "[redacted]"),
    } as ReturnType<RunService["redactor"]>);
    const { c } = client(f);
    expect(JSON.stringify(await c.trajectory(f.run.id))).not.toContain(secret);
    expect(readFileSync(f.path, "utf8")).not.toContain(secret);
    expect(readFileSync(file, "utf8")).toContain(secret);
  });
  it("selects the root Codex rollout, and failure diagnosis uses that same session", async () => {
    const f = fixture();
    const parent = f.source();
    const child = join(parent, "..", "child.jsonl");
    writeFileSync(
      child,
      JSON.stringify({
        type: "session_meta",
        payload: { source: { subagent: { thread_spawn: {} } } },
      }) +
        "\n" +
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_complete", error: { message: "Unauthorized" } },
        }),
    );
    const trajectory = await f.runs.trajectory(f.run.id);
    expect(trajectory?.session_id).not.toBe("child");
    expect(await runAgentFailure(f.runs.dirs(f.run.id).agent)).toBeNull();
  });
  it("forwards trajectory reads, rebuilds and projection to the worker, including after mirroring ended", async () => {
    const worker = fixture("remote-run");
    worker.source();
    worker.store.putRun({ ...worker.run, origin: "primary" });
    const workerApp = createWorkerApp({
      runs: worker.runs,
      token: () => "worker-token",
      profiles: async () => [],
      bundles: worker.paths.bundles,
      datasets: { list: () => [] } as never,
    });
    const node = new NodeClient("http://worker.test", "worker-token");
    const primary = fixture("remote-run");
    primary.store.putRun({ ...primary.run, remote: true, node: "worker" });
    const cluster = {
      trajectory: (run: Run, rebuild: boolean, source?: AtifSource) =>
        node.trajectory(run.id, rebuild, source),
      trajectoryFile: (run: Run, path: string) => node.trajectoryFile(run.id, path),
    } as ClusterService;
    const { app, c } = client(primary, cluster);
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) =>
      String(url).startsWith("http://worker.test")
        ? workerApp.request(url, init)
        : app.request(url, init),
    );
    const t = await c.trajectory(primary.run.id);
    assert(t);
    expect(existsSync(worker.path)).toBe(true);
    expect(existsSync(primary.path)).toBe(false);
    expect(primary.runs.get(primary.run.id)?.tokens).toEqual(
      worker.runs.get(worker.run.id)?.tokens,
    );
    expect(primary.runs.get(primary.run.id)?.tokens).not.toBeNull();
    expect(primary.runs.get(primary.run.id)?.trajectory).toEqual(
      worker.runs.get(worker.run.id)?.trajectory,
    );
    expect((await c.session(primary.run.id)).agent).toEqual(projectTranscript(t));
    expect(await c.rebuildTrajectory(primary.run.id)).toEqual(t);
    mkdirSync(worker.runs.dirs(worker.run.id).output, { recursive: true });
    writeFileSync(join(worker.runs.dirs(worker.run.id).output, "native.json"), JSON.stringify(t));
    const imported = await c.rebuildTrajectory(primary.run.id, {
      format: "atif",
      path: "native.json",
    });
    expect(imported?.extra?.orbit?.importer.name).toBe("atif-import");
    expect(primary.runs.get(primary.run.id)?.trajectory?.source).toEqual({
      format: "atif",
      path: "native.json",
    });
    expect(worker.runs.get(worker.run.id)?.trajectory?.source).toEqual(
      primary.runs.get(primary.run.id)?.trajectory?.source,
    );
    worker.store.putRun({ ...worker.run, origin: null });
    expect(
      (
        await workerApp.request(`/cluster/v1/runs/${worker.run.id}/trajectory`, {
          headers: { authorization: "Bearer worker-token" },
        })
      ).status,
    ).toBe(404);
    await expect(c.trajectory(primary.run.id)).rejects.toThrow(/unavailable/);
    expect((await c.session(primary.run.id)).agentError).toMatch(/unavailable/);
  });
});
