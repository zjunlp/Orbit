import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tryConnect } from "../src/client/index.ts";
import { orbitPaths } from "../src/config/paths.ts";
import { startDaemon } from "../src/daemon/server.ts";

const dir = mkdtempSync(join(tmpdir(), "orbit-port-"));
const probe = async () => ({
  node: "t",
  probedAt: new Date().toISOString(),
  gpus: [],
  gpuError: null,
  devices: [],
  cpu: { count: 4, load1: 0, busy: 0 },
  memory: { totalGB: 16, availableGB: 16 },
  disk: { path: dir, totalGB: 100, freeGB: 100 },
});

/** Another user's daemon holding a port. */
let busy: Server;
let port = 0;
beforeAll(async () => {
  busy = createServer();
  await new Promise<void>((r) => busy.listen(0, "127.0.0.1", r));
  port = (busy.address() as { port: number }).port;
});
afterAll(() => {
  busy.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("daemon port", () => {
  it("takes a free port when the default one is busy, and clients still find it", async () => {
    const paths = { ...orbitPaths({ ORBIT_HOME: join(dir, "a") }), port };
    const d = await startDaemon(paths, { probe });
    try {
      expect(new URL(d.url).port).not.toBe(String(port));
      expect(await tryConnect(paths)).not.toBeNull();
    } finally {
      await d.stop();
    }
  });

  it("fails when ORBIT_PORT asked for the busy port", async () => {
    const paths = orbitPaths({ ORBIT_HOME: join(dir, "b"), ORBIT_PORT: String(port) });
    await expect(startDaemon(paths, { probe })).rejects.toThrow(/EADDRINUSE/);
    expect(existsSync(join(paths.home, "daemon.lock"))).toBe(false);
    const d = await startDaemon(paths, { port: 0, probe });
    await d.stop();
  });

  it("refuses a second daemon on the same home before port fallback and releases on stop", async () => {
    const paths = orbitPaths({ ORBIT_HOME: join(dir, "single") });
    const d = await startDaemon(paths, { port: 0, probe });
    try {
      await expect(
        startDaemon({ ...paths, port: Number(new URL(d.url).port) }, { probe }),
      ).rejects.toThrow(`running process PID ${process.pid}`);
      expect((await tryConnect(paths))?.info.url).toBe(d.url);
    } finally {
      await d.stop();
    }
    expect(existsSync(join(paths.home, "daemon.lock"))).toBe(false);
    const restarted = await startDaemon(paths, { port: 0, probe });
    await restarted.stop();
  });
});
