// Filesystem fixtures and explicit Docker fakes; real Docker is checked separately.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { orbitPaths, runDirs } from "../src/config/paths.ts";
import { Run, RunSpec } from "../src/contracts/index.ts";
import * as docker from "../src/executor/docker.ts";
import { resumeAgentCommand } from "../src/harness/index.ts";
import { Redactor } from "../src/lib/redact.ts";
import { capture, checkpointDir, restore, resumeSpec } from "../src/runs/checkpoint.ts";
import { requireAgent } from "../test-support/agents.ts";

vi.mock("../src/executor/docker.ts", async (original) => ({
  ...(await original<typeof docker>()),
  inspectContainer: vi.fn(async () => ({ running: false })),
  writableSize: vi.fn(async () => 100),
  commitCheckpoint: vi.fn(async () => `sha256:${"a".repeat(64)}`),
  removeCheckpoint: vi.fn(async () => true),
  copyFromContainer: vi.fn(),
}));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "orbit-checkpoint-"));
  roots.push(home);
  const paths = orbitPaths({ ORBIT_HOME: home });
  const run = Run.parse({
    id: "source",
    spec: {
      image: "fixture",
      command: ["codex", "exec", "--model", "fixture", "solve"],
      checkpoint: {},
      timeoutMin: 30,
      passEnv: ["FIXTURE_KEY"],
    },
    state: "failed",
    reason: "exit code 1",
    exitCode: 1,
    node: paths.node,
    image: "fixture",
    containerId: "container",
    lease: null,
    code: null,
    cleanup: "done",
    note: "",
    createdAt: "2026-10-16T00:00:00Z",
    startedAt: "2026-10-16T00:00:00Z",
    endedAt: "2026-10-16T00:05:00Z",
  });
  const ctx = {
    dirs: (id: string) => runDirs(paths, id),
    homeLabel: "fixture",
    mustGet: () => run,
    save: vi.fn(),
    redactor: () => new Redactor([]),
  };
  mkdirSync(ctx.dirs(run.id).output, { recursive: true });
  writeFileSync(join(ctx.dirs(run.id).output, "progress"), "preserved");
  mkdirSync(join(ctx.dirs(run.id).orbit, "phases"));
  writeFileSync(join(ctx.dirs(run.id).orbit, "phases", "main.exit"), "1");
  const agent = join(ctx.dirs(run.id).agent, "codex");
  mkdirSync(join(agent, "sessions"), { recursive: true });
  writeFileSync(join(agent, "auth.json"), "fixture-secret");
  writeFileSync(join(agent, "sessions", "rollout-11111111-1111-1111-1111-111111111111.jsonl"), "");
  vi.mocked(docker.writableSize).mockResolvedValue(100);
  vi.mocked(docker.copyFromContainer).mockImplementation(async (_id, src, dest) => {
    cpSync(src === "/orbit" ? ctx.dirs(run.id).orbit : ctx.dirs(run.id).workspace, dest, {
      recursive: true,
    });
    return null;
  });
  return { ctx, run };
}

it("captures immutable output and native session, clears credentials and resets phase markers on restore", async () => {
  const { ctx, run } = fixture();
  await capture(ctx, run.id, "container");
  expect(run.checkpoint).toMatchObject({
    state: "ready",
    session: { harness: "codex", sessionId: "11111111-1111-1111-1111-111111111111" },
  });
  const root = checkpointDir(ctx, run.id);
  expect(existsSync(join(root, "orbit", "agent", "codex", "auth.json"))).toBe(false);
  expect(existsSync(join(root, "orbit", "phases"))).toBe(false);
  expect(docker.commitCheckpoint).toHaveBeenCalledWith(
    "container",
    expect.any(String),
    expect.arrayContaining(["FIXTURE_KEY", "ORBIT_RELAY_API_KEY"]),
    expect.objectContaining({ "orbit.home": "fixture" }),
  );
  writeFileSync(join(ctx.dirs(run.id).output, "progress"), "changed after capture");
  const savedProgress = join(root, "orbit", "output", "progress");
  utimesSync(savedProgress, 946684800, 946684800);
  const next = Run.parse({ ...run, id: "next", checkpoint: null, spec: resumeSpec(run) });
  await restore(ctx, run, next);
  expect(readFileSync(join(ctx.dirs(next.id).output, "progress"), "utf8")).toBe("preserved");
  expect(statSync(join(ctx.dirs(next.id).output, "progress")).mtimeMs).toBe(946684800000);
  expect(next.spec.timeoutMin).toBe(25);
  expect(next.spec.command.slice(0, 3)).toEqual(["codex", "exec", "resume"]);
  expect(next.spec.tags).toEqual({ resumedFrom: run.id });
  expect(next.spec.group).toBeUndefined();
});

it("rejects oversized layers before copying or committing and leaves an explicit failure", async () => {
  const { ctx, run } = fixture();
  vi.mocked(docker.writableSize).mockResolvedValue(5 * 1024 ** 3);
  await capture(ctx, run.id, "container");
  expect(run.checkpoint).toMatchObject({
    state: "failed",
    imageId: null,
    reason: expect.stringContaining("size limit"),
  });
  expect(docker.copyFromContainer).not.toHaveBeenCalled();
  expect(docker.commitCheckpoint).not.toHaveBeenCalled();
  expect(() => resumeSpec(run)).toThrow("no usable checkpoint");
});

it("does not charge checkpoint collection time to the continued command", async () => {
  const { ctx, run } = fixture();
  await capture(ctx, run.id, "container", 2);
  expect(resumeSpec(run, ["true"]).timeoutMin).toBe(28);
});

it("rejects oversized mounted files before duplicating them", async () => {
  const { ctx, run } = fixture();
  run.spec.checkpoint = { maxSizeGB: 500 / 1024 ** 3 };
  writeFileSync(join(ctx.dirs(run.id).output, "large"), "x".repeat(1000));
  await capture(ctx, run.id, "container");
  expect(run.checkpoint).toMatchObject({ state: "failed", imageId: null });
  expect(docker.copyFromContainer).not.toHaveBeenCalled();
  expect(docker.commitCheckpoint).not.toHaveBeenCalled();
});

it("records copy failures without publishing an unusable image", async () => {
  const { ctx, run } = fixture();
  vi.mocked(docker.copyFromContainer).mockResolvedValue("fixture copy failed");
  await capture(ctx, run.id, "container");
  expect(run.checkpoint).toMatchObject({ state: "failed", imageId: null });
  expect(existsSync(checkpointDir(ctx, run.id))).toBe(false);
  expect(docker.commitCheckpoint).not.toHaveBeenCalled();
});

it.each(["orbit", "workspace"])(
  "rejects restoration when checkpoint %s is missing",
  async (path) => {
    const { ctx, run } = fixture();
    run.code = {
      repo: "/fixture",
      subdir: "",
      commit: null,
      branch: null,
      dirty: false,
      changedFiles: [],
      skippedSubmodules: [],
      fileCount: 1,
      bytes: 4,
    };
    mkdirSync(ctx.dirs(run.id).workspace);
    writeFileSync(join(ctx.dirs(run.id).workspace, "seed"), "seed");
    await capture(ctx, run.id, "container");
    const next = Run.parse({ ...run, id: "next", checkpoint: null, spec: resumeSpec(run) });
    rmSync(join(checkpointDir(ctx, run.id), path), { recursive: true });
    await expect(restore(ctx, run, next)).rejects.toThrow(`checkpoint files missing: ${path}`);
    expect(existsSync(ctx.dirs(next.id).orbit)).toBe(false);
  },
);

it("does not silently resume a missing session or reset an exhausted time budget", async () => {
  const { ctx, run } = fixture();
  await capture(ctx, run.id, "container");
  if (!run.checkpoint) throw new Error("missing fixture checkpoint");
  run.checkpoint.session = null;
  expect(() => resumeSpec(run)).toThrow("no native Agent session");
  expect(resumeSpec(run, ["true"]).command).toEqual(["true"]);
  run.spec.timeoutMin = 1;
  expect(() => resumeSpec(run, ["true"])).toThrow("exhausted");
});

it("can continue an already resumed native session without accumulating resume arguments", () => {
  for (const [command, harness] of [
    [
      ["codex", "exec", "--model", "fixture", "-c", 'model_reasoning_effort="low"', "solve"],
      "codex",
    ],
    [["claude", "-p", "--model", "fixture", "--effort", "low", "solve"], "claude-code"],
  ] as const) {
    const session = { sessionId: "11111111-1111-1111-1111-111111111111" };
    void command;
    const first = resumeAgentCommand(
      requireAgent(harness),
      { model: "fixture", effort: "low" },
      session,
    );
    expect(
      resumeAgentCommand(requireAgent(harness), { model: "fixture", effort: "low" }, session),
    ).toEqual(first);
    expect(first.join(" ")).toContain("low");
  }
});

it("rejects checkpoint policies whose writable state cannot be restored", () => {
  for (const extra of [
    { backend: "process", image: undefined },
    { mounts: [{ source: "/tmp", target: "/data", mode: "rw" }] },
    { project: "/repo", snapshot: false },
    { services: [{ name: "db", image: "fixture" }] },
  ])
    expect(
      RunSpec.safeParse({ image: "fixture", command: ["true"], checkpoint: {}, ...extra }).success,
    ).toBe(false);
});
