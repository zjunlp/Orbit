// Recovery fixtures use an explicit fake executor; real execution is covered by e2e.docker.test.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ensureHome, orbitPaths } from "../src/config/paths.ts";
import { Run } from "../src/contracts/index.ts";
import * as docker from "../src/executor/docker.ts";
import { AGENT_SETUP_TIMEOUT } from "../src/runs/launch.ts";
import { RunService } from "../src/runs/service.ts";
import { UsageSampler } from "../src/runs/usage.ts";
import { Store } from "../src/store/index.ts";

vi.mock("../src/executor/docker.ts", async (original) => ({
  ...(await original<typeof docker>()),
  inspectContainer: vi.fn(),
  waitContainer: vi.fn(),
  followLogs: () => ({ proc: { kill: vi.fn() }, done: Promise.resolve() }),
  removeContainer: vi.fn(async () => true),
  stopContainer: vi.fn(async () => true),
  containersWithLabel: vi.fn(async () => []),
}));
vi.mock("../src/runs/process.ts", async (original) => ({
  ...(await original<typeof import("../src/runs/process.ts")>()),
  procAlive: () => false,
  groupAlive: () => false,
}));

it.each([
  ["docker", 0, false],
  ["docker", 7, false],
  ["process", 0, false],
  ["process", 7, false],
  ["docker", 0, true],
] as const)(
  "recovers an exited %s run (%i) with its persisted setup timeout (present=%s)",
  async (backend, code, setupTimedOut) => {
    const home = mkdtempSync(join(tmpdir(), "orbit-timeout-recovery-"));
    const paths = orbitPaths({ ORBIT_HOME: home });
    ensureHome(paths);
    const store = new Store(paths.db);
    const runs = new RunService({ store, paths, probe: vi.fn() });
    const run = Run.parse({
      id: "recovered",
      spec: {
        backend,
        ...(backend === "docker" ? { image: "fixture" } : {}),
        command: ["true"],
        timeoutMin: 1,
      },
      state: "running",
      reason: null,
      exitCode: null,
      node: paths.node,
      image: "fixture",
      containerId: backend === "docker" ? "fixture-container" : null,
      proc: backend === "process" ? { pid: 123456, start: "0" } : null,
      lease: null,
      code: null,
      cleanup: "pending",
      note: "",
      createdAt: "2020-01-01T00:00:00Z",
      startedAt: "2020-01-01T00:00:00Z",
      endedAt: null,
    });
    const dirs = runs.dirs(run.id);
    mkdirSync(dirs.output, { recursive: true });
    writeFileSync(dirs.log, "");
    writeFileSync(join(dirs.root, "exit-code"), String(code));
    const setupFailure = "Agent install failed (timed out after 2s); see orbit/agent/setup.log";
    if (setupTimedOut) writeFileSync(join(dirs.root, AGENT_SETUP_TIMEOUT), setupFailure);
    store.putRun(run);
    vi.mocked(docker.inspectContainer).mockResolvedValue({
      id: "fixture-container",
      running: false,
      exitCode: code,
      oomKilled: false,
      health: null,
      gpuIds: [],
      pid: 0,
    });
    vi.mocked(docker.waitContainer).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return code;
    });
    const stop = UsageSampler.prototype.stop;
    const delayed = vi.spyOn(UsageSampler.prototype, "stop").mockImplementation(async function (
      this: UsageSampler,
    ) {
      await new Promise((r) => setTimeout(r, 20));
      return stop.call(this);
    });
    try {
      await runs.start();
      await expect.poll(() => runs.get(run.id)?.sizeBytes).not.toBeNull();
      expect(runs.get(run.id)).toMatchObject({
        state: code === 0 && !setupTimedOut ? "succeeded" : "failed",
        exitCode: code,
        reason: setupTimedOut ? setupFailure : code === 0 ? null : "exit code 7",
        cleanup: "done",
      });
      expect(store.events(run.id).some((e) => e.kind === "timeout")).toBe(false);
    } finally {
      await runs.stop();
      delayed.mockRestore();
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  },
);
