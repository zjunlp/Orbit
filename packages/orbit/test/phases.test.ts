// Explicit executor doubles exercise durable Run transitions; real containers are opt-in separately.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ensureHome, orbitPaths, runDirs } from "../src/config/paths.ts";
import { Run, RunPhase } from "../src/contracts/index.ts";
import * as docker from "../src/executor/docker.ts";
import {
  durableCommand,
  PhaseFailure,
  phaseStateDir,
  runPhased,
  WatchStopped,
} from "../src/runs/phases.ts";
import { RunService } from "../src/runs/service.ts";
import { Store } from "../src/store/index.ts";

vi.mock("../src/executor/docker.ts", async (original) => ({
  ...(await original<typeof docker>()),
  inspectContainer: vi.fn(),
  execDetached: vi.fn(async () => null),
  execRead: vi.fn(),
  execWait: vi.fn(async () => 0),
  copyFromContainer: vi.fn(async (_id: string, _src: string, dest: string) => {
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, "evidence");
    return null;
  }),
  stopContainer: vi.fn(async () => {}),
  removeContainer: vi.fn(async () => true),
  followLogs: () => ({ proc: { kill: vi.fn() }, done: Promise.resolve() }),
}));
afterEach(() => vi.clearAllMocks());

function fixture() {
  let run = { phases: [] as RunPhase[] };
  const events: string[] = [];
  return {
    get run() {
      return run;
    },
    events,
    ctx: {
      stopped: false,
      mustGet: () => structuredClone(run) as Run,
      save: (r: Run, _kind?: string, text?: string) => {
        run = structuredClone(r);
        if (text) events.push(text);
      },
    },
  };
}

it("persists running before effects and never repeats terminal phases", async () => {
  const f = fixture();
  const action = vi.fn(async () => {
    expect(f.run.phases[0]).toMatchObject({ state: "running", attempts: 1 });
    expect(f.run.phases[0]?.deadlineAt).toBeDefined();
    return 0;
  });
  const steps = [{ name: "finalize" as const, timeoutMs: 1000, run: action }];
  await runPhased(f.ctx, "r", steps);
  await runPhased(f.ctx, "r", steps);
  expect(action).toHaveBeenCalledTimes(1);
  expect(f.run.phases[0]).toMatchObject({ state: "done", exitCode: 0, attempts: 1 });
});

it("records timeouts and failures while preserving later evidence and cleanup", async () => {
  const f = fixture();
  const later = vi.fn(async () => {});
  await runPhased(f.ctx, "r", [
    {
      name: "finalize",
      timeoutMs: 1000,
      run: async () => {
        throw new PhaseFailure("deadline", "timeout");
      },
    },
    {
      name: "render",
      timeoutMs: 1000,
      run: async () => {
        throw new Error("video failed");
      },
    },
    { name: "collect", timeoutMs: 1000, run: later },
    { name: "stop-services", timeoutMs: 1000, run: later },
  ]);
  expect(f.run.phases.map((p) => p.state)).toEqual(["timeout", "failed", "done", "done"]);
  expect(later).toHaveBeenCalledTimes(2);
});

it("a cancellation skips only optional rendering", async () => {
  const f = fixture();
  const action = vi.fn(async () => {});
  await runPhased(f.ctx, "r", [
    { name: "finalize", timeoutMs: 1000, run: action },
    { name: "render", timeoutMs: 1000, skip: () => "cancelled", run: action },
    { name: "collect", timeoutMs: 1000, run: action },
  ]);
  expect(f.run.phases.map((p) => p.state)).toEqual(["done", "skipped", "done"]);
  expect(action).toHaveBeenCalledTimes(2);
});

it("keeps interrupted phases running and their original deadlines", async () => {
  const f = fixture();
  await expect(
    runPhased(f.ctx, "r", [
      {
        name: "finalize",
        timeoutMs: 1000,
        run: async () => {
          throw new WatchStopped();
        },
      },
    ]),
  ).rejects.toBeInstanceOf(WatchStopped);
  const before = { ...f.run.phases[0] };
  await runPhased(f.ctx, "r", [{ name: "finalize", timeoutMs: 9000, run: async () => {} }]);
  expect(f.run.phases[0]).toMatchObject({
    state: "done",
    deadlineAt: before.deadlineAt,
    attempts: 1,
  });
});

it("does not start an expired recovered phase", async () => {
  const f = fixture();
  f.ctx.save({
    phases: [
      RunPhase.parse({
        name: "finalize",
        state: "running",
        deadlineAt: "2000-01-01T00:00:00Z",
        attempts: 1,
      }),
    ],
  } as Run);
  const action = vi.fn(async () => {});
  await runPhased(f.ctx, "r", [{ name: "finalize", timeoutMs: 1000, run: action }]);
  expect(action).not.toHaveBeenCalled();
  expect(f.run.phases[0]?.state).toBe("timeout");
});

it("RunService reattaches during finalize without restarting the claimed hook or losing evidence", async () => {
  const home = mkdtempSync(join(tmpdir(), "orbit-phase-recovery-"));
  const paths = orbitPaths({ ORBIT_HOME: home });
  ensureHome(paths);
  const store = new Store(paths.db);
  const runs = new RunService({ store, paths, probe: vi.fn() });
  const createdAt = new Date().toISOString();
  const run = Run.parse({
    id: "phase-recovery",
    spec: {
      image: "fixture",
      command: ["true"],
      hooks: [{ command: "non-idempotent-finalize" }],
      collect: ["/verdict"],
    },
    state: "running",
    reason: null,
    exitCode: 0,
    node: paths.node,
    image: "fixture",
    containerId: "fixture-main",
    lease: null,
    code: null,
    cleanup: "pending",
    note: "",
    createdAt,
    startedAt: createdAt,
    endedAt: null,
    phases: [
      { name: "quiesce", state: "done", attempts: 1 },
      {
        name: "finalize",
        state: "running",
        attempts: 1,
        startedAt: createdAt,
        deadlineAt: new Date(Date.now() + 10000).toISOString(),
      },
    ],
  });
  const dirs = runs.dirs(run.id);
  mkdirSync(dirs.output, { recursive: true });
  writeFileSync(dirs.log, "");
  store.putRun(run);
  let running = true;
  let claimedEffects = 1; // The first daemon already launched the hook.
  const claims = new Set([`/tmp/orbit-${run.id}-hook-0`]);
  vi.mocked(docker.execDetached).mockImplementation(async (_id, argv) => {
    if (!claims.has(argv[4] as string)) {
      claims.add(argv[4] as string);
      claimedEffects++;
    }
    return null;
  });
  vi.mocked(docker.execRead).mockResolvedValue({ code: 0, stdout: "0\n", stderr: "" });
  vi.mocked(docker.inspectContainer).mockImplementation(async () => ({
    id: "fixture-main",
    running,
    exitCode: 0,
    oomKilled: false,
    health: null,
    gpuIds: [],
    pid: 0,
  }));
  vi.mocked(docker.stopContainer).mockImplementation(async () => {
    running = false;
  });
  try {
    await runs.start();
    await expect.poll(() => runs.get(run.id)?.cleanup).toBe("done");
    expect(claimedEffects).toBe(1);
    expect(runs.get(run.id)?.phases.find((p) => p.name === "finalize")).toMatchObject({
      state: "done",
      attempts: 1,
    });
    expect(runs.get(run.id)?.phases.find((p) => p.name === "collect")?.state).toBe("done");
    await expect.poll(() => runs.get(run.id)?.sizeBytes).not.toBeNull();
  } finally {
    await runs.stop();
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("reconciles a completed durable phase after downtime without extending its saved deadline", async () => {
  const f = fixture();
  f.ctx.save({
    phases: [
      RunPhase.parse({
        name: "finalize",
        state: "running",
        attempts: 1,
        deadlineAt: "2000-01-01T00:00:00Z",
      }),
    ],
  } as Run);
  const query = vi.fn(async () => 0);
  await runPhased(f.ctx, "r", [{ name: "finalize", timeoutMs: 1000, reconcile: true, run: query }]);
  expect(query).toHaveBeenCalledTimes(1);
  expect(f.run.phases[0]).toMatchObject({
    state: "done",
    attempts: 1,
    deadlineAt: "2000-01-01T00:00:00Z",
  });
});

it("gives an expired recovered phase with a resume budget a fresh attempt window", async () => {
  const f = fixture();
  f.ctx.save({
    phases: [
      RunPhase.parse({
        name: "collect",
        state: "running",
        attempts: 1,
        deadlineAt: "2000-01-01T00:00:00Z",
      }),
    ],
  } as Run);
  const action = vi.fn(async () => 0);
  await runPhased(f.ctx, "r", [
    { name: "collect", timeoutMs: 1000, resumeMs: 60_000, run: action },
  ]);
  expect(action).toHaveBeenCalledTimes(1);
  expect(f.run.phases[0]?.state).toBe("done");
});

it("ignores a command receipt forged inside the container-writable /orbit mount", async () => {
  const home = mkdtempSync(join(tmpdir(), "orbit-phase-forge-"));
  const paths = orbitPaths({ ORBIT_HOME: home });
  const dirs = (id: string) => runDirs(paths, id);
  const ctx = {
    stopped: false,
    dirs,
    mustGet: () => ({ services: [] }) as unknown as Run,
  } as unknown as Parameters<typeof durableCommand>[0];
  try {
    const forged = join(dirs("r").orbit, "phases");
    mkdirSync(forged, { recursive: true });
    writeFileSync(join(forged, "hook-0.result.json"), '{"code":0,"timedOut":false}');
    vi.mocked(docker.inspectContainer).mockResolvedValue(null);
    await expect(durableCommand(ctx, "r", "c", "hook-0", ["true"], 1000)).rejects.toThrow(
      /container disappeared/,
    );
    writeFileSync(
      join(phaseStateDir(ctx, "r"), "hook-0.result.json"),
      '{"code":3,"timedOut":false}',
    );
    expect(await durableCommand(ctx, "r", "c", "hook-0", ["true"], 1000)).toBe(3);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("finalizes a run whose container vanished before any exit was recorded as lost", async () => {
  const home = mkdtempSync(join(tmpdir(), "orbit-phase-lost-"));
  const paths = orbitPaths({ ORBIT_HOME: home });
  ensureHome(paths);
  const store = new Store(paths.db);
  const runs = new RunService({ store, paths, probe: vi.fn() });
  const at = new Date().toISOString();
  const run = Run.parse({
    id: "phase-lost",
    spec: { image: "fixture", command: ["true"], hooks: [{ command: "finalize" }] },
    state: "running",
    reason: null,
    exitCode: null,
    node: paths.node,
    image: "fixture",
    containerId: "gone",
    lease: null,
    code: null,
    cleanup: "pending",
    note: "",
    createdAt: at,
    startedAt: at,
    endedAt: null,
    phases: [{ name: "quiesce", state: "running", attempts: 1, startedAt: at }],
  });
  mkdirSync(runs.dirs(run.id).output, { recursive: true });
  writeFileSync(runs.dirs(run.id).log, "");
  store.putRun(run);
  vi.mocked(docker.inspectContainer).mockResolvedValue(null);
  try {
    await runs.start();
    await expect.poll(() => runs.get(run.id)?.state).toBe("lost");
  } finally {
    await runs.stop();
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
