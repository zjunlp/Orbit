// Real store, converters and HTTP handlers; scheduling probe and HTTP transport are explicit doubles.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTrajectory } from "../src/cli/trajectory.ts";
import { OrbitClient } from "../src/client/index.ts";
import { NodeClient } from "../src/cluster/client.ts";
import { orbitPaths } from "../src/config/paths.ts";
import { AtifSource, Run, type AtifTrajectory as Trajectory } from "../src/contracts/index.ts";
import { type AppDeps, createApp } from "../src/daemon/app.ts";
import { RunService } from "../src/runs/service.ts";
import { convertCodexTrajectory } from "../src/sessions/codex.ts";
import { MAX_SESSION_BYTES } from "../src/sessions/files.ts";
import { importAtif } from "../src/sessions/import.ts";
import { Store } from "../src/store/index.ts";

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const s of stores.splice(0)) s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const source = AtifSource.parse({ format: "atif", path: "native/trajectory.json" });
function native(): Trajectory {
  const t = convertCodexTrajectory(
    readFileSync(new URL("fixtures/atif/codex.jsonl", import.meta.url), "utf8"),
  ).trajectory;
  t.schema_version = "ATIF-v1.8";
  delete t.extra;
  t.extra = { provider: { kept: true } };
  return t;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "orbit-atif-import-"));
  roots.push(root);
  const paths = orbitPaths({ ORBIT_HOME: root });
  const store = new Store(":memory:");
  stores.push(store);
  const runs = new RunService({ paths, store, probe: vi.fn() });
  const run = Run.parse({
    id: "import",
    spec: { backend: "process", command: ["true"], trajectory: source },
    state: "succeeded",
    cleanup: "done",
    reason: null,
    exitCode: 0,
    node: "fixture",
    containerId: null,
    image: null,
    lease: null,
    code: null,
    note: "",
    createdAt: "2026-11-13T00:00:00Z",
    startedAt: null,
    endedAt: "2026-11-13T00:01:00Z",
  });
  store.putRun(run);
  const dirs = runs.dirs(run.id);
  mkdirSync(join(dirs.output, "native"), { recursive: true });
  const file = join(dirs.output, source.path);
  const saved = join(dirs.orbit, "trajectory/trajectory.json");
  const app = createApp({ runs, token: "fixture", webDir: null } as AppDeps);
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => app.request(url, init));
  const c = new OrbitClient({ url: "http://orbit.test", token: "fixture", pid: 0 });
  return { root, store, runs, run, dirs, file, saved, c, app };
}
describe("native ATIF import", () => {
  it.each(["ATIF-v1.5", "ATIF-v1.6", "ATIF-v1.7", "ATIF-v1.8"] as const)(
    "preserves %s fields and provider metadata while adding provenance",
    (schema_version) => {
      const t = native();
      t.schema_version = schema_version;
      const raw = JSON.stringify(t);
      const imported = importAtif(raw, source).trajectory;
      expect(imported.schema_version).toBe(schema_version);
      expect(imported.steps).toEqual(t.steps);
      expect(imported.final_metrics).toEqual(t.final_metrics);
      expect(imported.extra?.provider).toEqual({ kept: true });
      expect(imported.extra?.orbit).toMatchObject({
        importer: { name: "atif-import", version: 1 },
        sources: [
          {
            path: source.path,
            sha256: createHash("sha256").update(raw).digest("hex"),
            bytes: Buffer.byteLength(raw),
          },
        ],
        metadata: { source, source_root: "output" },
      });
    },
  );
  it("rejects unsupported versions, fields, invalid pairing and unsafe source paths", () => {
    for (const path of [
      "../auth.json",
      "/etc/passwd",
      "a/../b",
      "a//b",
      "https://invalid/trace",
      "a\\b",
      "a\nb",
    ])
      expect(AtifSource.safeParse({ format: "atif", path }).success).toBe(false);
    expect(() => importAtif('{"schema_version":"ATIF-v9"}', source)).toThrow();
    expect(() =>
      importAtif(JSON.stringify({ ...native(), unknown_field: true }), source),
    ).toThrow();
    const t = native();
    const step = t.steps[1];
    assert(step?.observation?.results[0]);
    step.observation.results[0].source_call_id = "absent";
    expect(() => importAtif(JSON.stringify(t), source)).toThrow();
  });
  it("recursively adopts child provenance and preserves copied context and reported metrics", () => {
    const t = native();
    const child = native();
    child.trajectory_id = "child";
    t.subagent_trajectories = [child];
    const imported = importAtif(JSON.stringify(t), source).trajectory;
    expect(imported.subagent_trajectories?.[0]?.extra?.orbit?.importer.name).toBe("atif-import");
    expect(imported.subagent_trajectories?.[0]?.steps).toEqual(child.steps);
  });
  it("automatically adopts declared output evidence and persists token totals without a native CLI session", async () => {
    const f = fixture();
    const t = native();
    writeFileSync(f.file, JSON.stringify(t));
    const imported = await f.c.trajectory(f.run.id);
    assert(imported);
    expect(imported.schema_version).toBe("ATIF-v1.8");
    expect(imported.steps).toEqual(t.steps);
    expect(f.runs.get(f.run.id)).toMatchObject({
      trajectory: { source, importer: { name: "atif-import", version: 1 } },
      tokens: { input: 220, output: 22, source: "session" },
    });
    expect(JSON.parse(readFileSync(f.saved, "utf8"))).toEqual(imported);
    expect((await f.c.session(f.run.id)).agent?.messages.some((m) => m.stepId === 2)).toBe(true);
  });
  it("adopts the original Cua exporter fixture with local PNG media", async () => {
    const f = fixture();
    const raw = readFileSync(new URL("fixtures/atif/cua-native.json", import.meta.url), "utf8");
    mkdirSync(join(f.dirs.output, "native/imgs"), { recursive: true });
    writeFileSync(
      join(f.dirs.output, "native/imgs/atif_0_0.png"),
      readFileSync(new URL("fixtures/atif/cua-pixel.png", import.meta.url)),
    );
    writeFileSync(f.file, raw);
    const t = await f.c.trajectory(f.run.id);
    expect(t?.schema_version).toBe("ATIF-v1.8");
    expect(t?.steps).toHaveLength(3);
    expect(f.runs.get(f.run.id)?.tokens).toMatchObject({ input: 10, output: 2 });
  });
  it("imports old runs through CLI, remembers the source for rebuild and preserves previous files on failure", async () => {
    const f = fixture();
    const run = { ...f.run, spec: { ...f.run.spec, trajectory: undefined } };
    f.store.putRun(run);
    writeFileSync(f.file, JSON.stringify(native()));
    const print = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerTrajectory(program, async () => f.c);
    await program.parseAsync(["trajectory", "import", run.id, source.path, "--json"], {
      from: "user",
    });
    expect(JSON.parse(String(print.mock.calls.at(-1)?.[0])).schema_version).toBe("ATIF-v1.8");
    const first = readFileSync(f.saved, "utf8");
    await f.c.rebuildTrajectory(run.id);
    expect(readFileSync(f.saved, "utf8")).toBe(first);
    expect(existsSync(join(f.dirs.orbit, "trajectory/trajectory.atif-import-v1.json"))).toBe(true);
    writeFileSync(f.file, "broken");
    await expect(f.c.rebuildTrajectory(run.id)).rejects.toThrow();
    expect(readFileSync(f.saved, "utf8")).toBe(first);
    expect(f.runs.get(run.id)?.state).toBe("succeeded");
  });
  it("copies image/audio bytes safely, supports content changes on rebuild and serves media through the API", async () => {
    const f = fixture();
    const t = native();
    const step = t.steps[1];
    assert(step);
    step.message = [
      { type: "image", source: { media_type: "image/png", path: "picture.png" } },
      { type: "audio", source: { media_type: "audio/wav", path: "clip.wav", duration_sec: 1 } },
    ];
    writeFileSync(join(f.dirs.output, "native/picture.png"), "first image");
    writeFileSync(join(f.dirs.output, "native/clip.wav"), "audio bytes");
    writeFileSync(f.file, JSON.stringify(t));
    const imported = await f.c.trajectory(f.run.id);
    assert(imported);
    const content = imported.steps[1]?.message;
    assert(Array.isArray(content));
    const part = content[0];
    assert(part?.type === "image");
    const response = await f.app.request(
      `/api/v1/runs/import/trajectory/files/${part.source.path}`,
      { headers: { authorization: "Bearer fixture" } },
    );
    expect(await response.text()).toBe("first image");
    const audio = content[1];
    assert(audio?.type === "audio");
    const res = await f.app.request(`/api/v1/runs/import/trajectory/files/${audio.source.path}`, {
      headers: { authorization: "Bearer fixture" },
    });
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(await res.text()).toBe("audio bytes");
    writeFileSync(join(f.dirs.output, "native/picture.png"), "changed image");
    const rebuilt = await f.c.rebuildTrajectory(f.run.id);
    const changed = rebuilt?.steps[1]?.message;
    assert(Array.isArray(changed));
    expect(changed[0]?.source?.path).not.toBe(part.source.path);
  });
  it("rejects missing, escaping, remote and oversized evidence without changing the previous import", async () => {
    const f = fixture();
    writeFileSync(f.file, JSON.stringify(native()));
    await f.c.trajectory(f.run.id);
    const previous = readFileSync(f.saved, "utf8");
    const outside = join(f.root, "outside.png");
    writeFileSync(outside, "private");
    symlinkSync(outside, join(f.dirs.output, "native/escape.png"));
    for (const path of [
      "escape.png",
      "../../../outside.png",
      "https://invalid/image.png",
      "missing.png",
    ]) {
      const t = native();
      const step = t.steps[1];
      assert(step);
      step.message = [{ type: "image", source: { media_type: "image/png", path } }];
      writeFileSync(f.file, JSON.stringify(t));
      await expect(f.c.rebuildTrajectory(f.run.id)).rejects.toThrow();
      expect(readFileSync(f.saved, "utf8")).toBe(previous);
    }
    truncateSync(f.file, MAX_SESSION_BYTES + 1);
    await expect(f.c.rebuildTrajectory(f.run.id)).rejects.toThrow(/exceeds/);
    const moved = join(f.root, "moved-output");
    renameSync(f.dirs.output, moved);
    symlinkSync(moved, f.dirs.output);
    await expect(f.c.rebuildTrajectory(f.run.id)).rejects.toThrow(/unsafe ATIF output/);
    expect(readFileSync(f.saved, "utf8")).toBe(previous);
  });
  it("rejects workers that ignore the requested import source", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify(native()), { headers: { "content-type": "application/json" } }),
    );
    const node = new NodeClient("http://worker.test", "fixture");
    await expect(node.trajectory("run", true, source)).rejects.toThrow(/did not adopt/);
  });
  it("previews active imports without persisting and refuses explicit import before cleanup", async () => {
    const f = fixture();
    writeFileSync(f.file, JSON.stringify(native()));
    f.store.putRun({ ...f.run, state: "running", cleanup: "pending", endedAt: null });
    expect(await f.c.trajectory(f.run.id)).not.toBeNull();
    expect(existsSync(f.saved)).toBe(false);
    await expect(f.c.rebuildTrajectory(f.run.id, source)).rejects.toThrow(/finished/);
  });
});
