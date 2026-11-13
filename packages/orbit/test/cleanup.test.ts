// Run cleanup ordering against a real store; container removal is an explicit double.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ensureHome, orbitPaths } from "../src/config/paths.ts";
import { Lease, Run } from "../src/contracts/index.ts";
import * as docker from "../src/executor/docker.ts";
import { cleanup } from "../src/runs/cleanup.ts";
import { Store } from "../src/store/index.ts";

vi.mock("../src/executor/docker.ts", async (original) => ({
  ...(await original<typeof docker>()),
  removeContainer: vi.fn(async () => true),
}));

const homes: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const at = "2026-11-11T00:00:00.000Z";

function fixture(backend: "docker" | "process" = "docker") {
  const home = mkdtempSync(join(tmpdir(), "orbit-cleanup-"));
  homes.push(home);
  const paths = orbitPaths({ ORBIT_HOME: home });
  ensureHome(paths);
  const store = new Store(paths.db);
  stores.push(store);
  const lease = Lease.parse({
    id: "lease",
    runId: "r",
    node: "n",
    gpuIds: ["GPU-0"],
    cpus: 1,
    memGB: 1,
    state: "active",
    createdAt: at,
    releasedAt: null,
  });
  const run = Run.parse({
    id: "r",
    spec: { command: ["true"], backend, ...(backend === "docker" ? { image: "fixture" } : {}) },
    state: "succeeded",
    reason: null,
    exitCode: 0,
    node: "n",
    image: null,
    containerId: "c",
    lease,
    code: null,
    cleanup: "pending",
    note: "",
    createdAt: at,
    startedAt: at,
    endedAt: at,
  });
  store.tx(() => {
    store.putRun(run);
    store.putLease(lease);
  });
  const events: string[] = [];
  const ctx = {
    store,
    mustGet: (id: string) => store.getRun(id) as Run,
    save: (r: Run, _kind?: string, text?: string) => {
      store.putRun(r);
      if (text) events.push(text);
    },
    cleanupProcess: vi.fn(async () => true),
    cleanupServices: vi.fn(async () => true),
    measure: vi.fn(async () => {}),
    trajectory: vi.fn(async () => null),
  } as unknown as Parameters<typeof cleanup>[0];
  return { store, run, ctx, events };
}

it("keeps the lease while container removal fails and releases it once removal succeeds", async () => {
  const f = fixture();
  vi.mocked(docker.removeContainer).mockResolvedValueOnce(false);
  await cleanup(f.ctx, f.run);
  expect(f.store.getRun("r")).toMatchObject({ cleanup: "failed", lease: { state: "active" } });
  expect(f.store.activeLeases().map((l) => l.id)).toEqual(["lease"]);
  expect(f.ctx.trajectory).not.toHaveBeenCalled();
  expect(f.events).toEqual(["container removal failed; lease kept until it succeeds"]);

  // A retry that fails again records nothing new.
  vi.mocked(docker.removeContainer).mockResolvedValueOnce(false);
  await cleanup(f.ctx, f.store.getRun("r") as Run);
  expect(f.events).toHaveLength(1);

  await cleanup(f.ctx, f.store.getRun("r") as Run);
  expect(docker.removeContainer).toHaveBeenLastCalledWith("c");
  const done = f.store.getRun("r");
  expect(done).toMatchObject({ cleanup: "done", lease: { state: "released" } });
  expect(done?.lease?.releasedAt).toEqual(expect.any(String));
  expect(f.store.activeLeases()).toEqual([]);
  expect(f.events.at(-1)).toBe("container removed, lease released");
});

it("keeps a process run's lease until its process and child containers are gone", async () => {
  const f = fixture("process");
  vi.mocked(f.ctx.cleanupProcess).mockResolvedValueOnce(false);
  await cleanup(f.ctx, f.run);
  expect(docker.removeContainer).not.toHaveBeenCalled();
  expect(f.store.getRun("r")?.cleanup).toBe("failed");
  expect(f.store.activeLeases()).toHaveLength(1);
  await cleanup(f.ctx, f.store.getRun("r") as Run);
  expect(f.store.getRun("r")?.cleanup).toBe("done");
  expect(f.store.activeLeases()).toEqual([]);
});

it("persists the generated summary before cleanup and keeps execution and cleanup independent of conversion failures", async () => {
  const f = fixture();
  const summary = {
    schema: "ATIF-v1.7" as const,
    steps: 1,
    completeness: "complete" as const,
    importer: { name: "codex-rollout", version: 1 },
  };
  const tokens = {
    input: 10,
    cachedInput: 2,
    cacheWrite: null,
    output: 3,
    reasoning: null,
    calls: 1,
    source: "session" as const,
  };
  vi.mocked(f.ctx.trajectory).mockImplementationOnce(async (id, finalized) => {
    expect(finalized).toBe(true);
    expect(docker.removeContainer).toHaveBeenCalled();
    expect(f.store.activeLeases()).toHaveLength(1);
    f.store.putRun({ ...f.ctx.mustGet(id), trajectory: summary, tokens });
    return null;
  });
  await cleanup(f.ctx, f.run);
  expect(f.store.getRun("r")).toMatchObject({
    state: "succeeded",
    cleanup: "done",
    trajectory: summary,
    tokens,
  });
  const failed = fixture();
  vi.mocked(failed.ctx.trajectory).mockRejectedValueOnce(new Error("invalid session"));
  await cleanup(failed.ctx, failed.run);
  expect(failed.store.getRun("r")).toMatchObject({
    state: "succeeded",
    cleanup: "done",
    trajectory: null,
  });
  expect(failed.store.activeLeases()).toEqual([]);
});
