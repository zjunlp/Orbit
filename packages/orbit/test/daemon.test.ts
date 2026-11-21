import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tryConnect } from "../src/client/index.ts";
import { readDaemonInfo } from "../src/config/daemon-info.ts";
import { ensureHome, orbitPaths, privateStateCheck } from "../src/config/paths.ts";
import { LogChunk, Run } from "../src/contracts/index.ts";
import { type StartedDaemon, startDaemon } from "../src/daemon/server.ts";
import { Store } from "../src/store/index.ts";

const home = mkdtempSync(join(tmpdir(), "orbit-test-"));
const paths = orbitPaths({ ORBIT_HOME: home });
let daemon: StartedDaemon;

beforeAll(async () => {
  ensureHome(paths);
  chmodSync(paths.home, 0o775);
  chmodSync(paths.runs, 0o775);
  const oldStore = new Store(paths.db);
  oldStore.close();
  chmodSync(paths.db, 0o644);
  daemon = await startDaemon(paths, { port: 0, tickMs: 200 });
  const store = new Store(paths.db);
  try {
    const at = "2026-10-16T00:00:00.000Z";
    store.putRun(
      Run.parse({
        id: "fixture",
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
        createdAt: at,
        startedAt: at,
        endedAt: at,
      }),
    );
  } finally {
    store.close();
  }
  mkdirSync(daemon.runs.dirs("fixture").output, { recursive: true });
  writeFileSync(join(daemon.runs.dirs("fixture").output, "a b.txt"), "fixture output");
});
afterAll(async () => {
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("daemon", () => {
  it("publishes its endpoint with a private token file", () => {
    expect(readDaemonInfo(paths)?.url).toBe(daemon.url);
    expect(statSync(paths.daemonFile).mode & 0o777).toBe(0o600);
    expect(privateStateCheck(paths).warn).toBe(false);
  });

  it("serves health and resources to an authorized client", async () => {
    const client = await tryConnect(paths);
    expect(client).not.toBeNull();
    expect((await client?.health())?.pid).toBe(process.pid);
    const r = await client?.resources();
    expect(r?.cpu.count).toBeGreaterThan(0);
    expect(r?.memory.totalGB).toBeGreaterThan(0);
  });

  it("rejects requests without the token", async () => {
    const res = await fetch(`${daemon.url}/api/v1/health`);
    expect(res.status).toBe(401);
  });

  it.each(["%", "%GG", "%E2%9C"])("returns 400 for malformed file escape %s", async (path) => {
    const res = await fetch(`${daemon.url}/api/v1/runs/fixture/files/${path}`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("invalid path") });
  });

  it("still serves valid escaped filenames", async () => {
    const res = await fetch(`${daemon.url}/api/v1/runs/fixture/files/a%20b.txt`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("fixture output");
  });

  it.each(["-1", "1.5", "1e21", "9007199254740992", "NaN", "Infinity", "abc"])(
    "rejects non-safe or negative integer query numbers: %s",
    async (number) => {
      for (const route of [
        "/runs?limit=",
        "/bench/jobs?limit=",
        "/runs/fixture/events?after=",
        "/runs/fixture/logs?limit=",
        "/runs/fixture/wait?timeout=",
      ]) {
        const res = await fetch(`${daemon.url}/api/v1${route}${number}`, {
          headers: { authorization: `Bearer ${daemon.token}` },
        });
        expect(res.status, route).toBe(400);
        expect(await res.json()).toMatchObject({
          error: expect.stringContaining("non-negative safe integer"),
        });
      }
    },
  );

  it.each(["1.5", "1e21", "9007199254740992", "NaN", "Infinity", "abc"])(
    "rejects a non-integer log offset: %s",
    async (number) => {
      const res = await fetch(`${daemon.url}/api/v1/runs/fixture/logs?offset=${number}`, {
        headers: { authorization: `Bearer ${daemon.token}` },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: expect.stringContaining("safe integer"),
      });
    },
  );

  it("reads the log tail from a negative offset", async () => {
    writeFileSync(daemon.runs.dirs("fixture").log, "first\nsecond\nthird\n");
    const get = async (offset: string) => {
      const res = await fetch(
        `${daemon.url}/api/v1/runs/fixture/logs?offset=${offset}&limit=4096`,
        {
          headers: { authorization: `Bearer ${daemon.token}` },
        },
      );
      expect(res.status).toBe(200);
      return LogChunk.parse(await res.json());
    };
    const tail = await get("-6");
    expect(tail.text).toBe("third\n");
    expect(tail.next).toBe(19);
    const whole = await get("-4096");
    expect(whole.text).toBe("first\nsecond\nthird\n");
    const head = await get("0");
    expect(head.text).toBe("first\nsecond\nthird\n");
  });

  it.each(["", "0", "1", "1e3", "9007199254740991"])(
    "accepts safe integer limits and the empty default: %s",
    async (limit) => {
      const res = await fetch(`${daemon.url}/api/v1/runs?limit=${limit}`, {
        headers: { authorization: `Bearer ${daemon.token}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        runs: [expect.objectContaining({ id: "fixture" })],
      });
    },
  );

  it("logs the browser in with a cookie and only redirects to local paths", async () => {
    const token = readDaemonInfo(paths)?.token ?? "";
    const login = (next: string) =>
      fetch(`${daemon.url}/login?token=${token}&next=${encodeURIComponent(next)}`, {
        redirect: "manual",
      });
    const ok = await login("/runs/x?tab=logs");
    expect(ok.headers.get("location")).toBe("/runs/x?tab=logs");
    const cookie = ok.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(cookie).toContain("orbit_token=");
    expect((await fetch(`${daemon.url}/api/v1/health`, { headers: { cookie } })).status).toBe(200);
    expect((await login("//evil.example")).headers.get("location")).toBe("/");
    expect((await login("https://evil.example")).headers.get("location")).toBe("/");
    expect((await login("/.//evil.example")).headers.get("location")).toBe("/");
    expect((await login(`${daemon.url}//evil.example`)).headers.get("location")).toBe("/");
  });

  it("refuses cross-site writes that rely on the cookie", async () => {
    const token = readDaemonInfo(paths)?.token ?? "";
    const cookie = `orbit_token=${token}`;
    const post = (headers: Record<string, string>) =>
      fetch(`${daemon.url}/api/v1/runs/none/cancel`, { method: "POST", headers });
    expect((await post({ cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ cookie, "sec-fetch-site": "cross-site" })).status).toBe(403);
    // Same-origin browser requests and bearer clients reach the route (404: no such run).
    expect((await post({ cookie, origin: daemon.url })).status).toBe(404);
    expect((await post({ authorization: `Bearer ${token}` })).status).toBe(404);
  });

  it("redeems browser login codes over HTTP with the same session cookie", async () => {
    const client = await tryConnect(paths);
    if (!client) throw new Error("fixture daemon not reachable");
    const { code } = await client.loginCode();
    const redeem = () => fetch(`${daemon.url}/login?code=${code}`, { redirect: "manual" });
    const response = await redeem();
    expect(response.status).toBe(302);
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect((await fetch(`${daemon.url}/api/v1/health`, { headers: { cookie } })).status).toBe(200);
    expect((await redeem()).status).toBe(401);
  });
});
