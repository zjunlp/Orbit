// Real HTTP handlers and temporary files, with explicit run-service fixtures and no daemon or executor.
import { EventEmitter } from "node:events";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { OrbitClient } from "../src/client/index.ts";
import { createWorkerApp } from "../src/cluster/worker.ts";
import { orbitPaths, runDirs } from "../src/config/paths.ts";
import { LogChunk, LoginCode, Run } from "../src/contracts/index.ts";
import { type AppDeps, createApp } from "../src/daemon/app.ts";
import { Redactor } from "../src/lib/redact.ts";
import type { RunService } from "../src/runs/service.ts";
import type { DatasetRegistry } from "../src/workspace/datasets.ts";

const home = mkdtempSync(join(tmpdir(), "orbit-security-api-"));
const paths = orbitPaths({ ORBIT_HOME: home });
const token = "fixture-daemon-token";
const secret = "fixture-process-secret";
const run = Run.parse({
  id: "fixture",
  spec: { backend: "process", command: ["true"] },
  state: "running",
  origin: "primary",
  reason: null,
  exitCode: null,
  node: "fixture",
  image: null,
  containerId: null,
  lease: null,
  code: null,
  cleanup: "pending",
  note: "",
  createdAt: "2026-10-16T00:00:00.000Z",
  startedAt: null,
  endedAt: null,
});
const dirs = runDirs(paths, run.id);
mkdirSync(dirs.output, { recursive: true });
const runs = Object.assign(new EventEmitter(), {
  get: (id: string) => (id === run.id ? run : null),
  dirs: () => dirs,
  redactor: () => new Redactor([secret]),
}) as unknown as RunService;
const app = createApp({ token, runs, paths, webDir: null, startedAt: run.createdAt } as AppDeps);
const worker = createWorkerApp({
  runs,
  datasets: {} as DatasetRegistry,
  profiles: async () => [],
  bundles: paths.bundles,
  token: () => token,
});
const headers = { authorization: `Bearer ${token}` };
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("browser login", () => {
  it("mints through the typed bearer client and redeems a code only once for the Web cookie", async () => {
    vi.stubGlobal("fetch", (input: string, init: RequestInit) => app.request(input, init));
    const client = new OrbitClient({ url: "http://orbit.test", token, pid: 0 });
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const login = await client.loginCode();
    expect(login.code).not.toContain(token);
    expect(Date.parse(login.expiresAt)).toBe(now + 30_000);
    const link = `/login?code=${login.code}&next=${encodeURIComponent("/runs/fixture?tab=logs#tail")}`;
    const results = await Promise.all([app.request(link), app.request(link)]);
    expect(results.map((r) => r.status).sort()).toEqual([302, 401]);
    const response = results.find((r) => r.status === 302);
    expect(response?.headers.get("location")).toBe("/runs/fixture?tab=logs#tail");
    expect(response?.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response?.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(response?.headers.get("cache-control")).toBe("no-store");
    const cookie = response?.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect((await app.request("/api/v1/health", { headers: { cookie } })).status).toBe(200);
    expect(
      (await app.request("/api/v1/login-code", { method: "POST", headers: { cookie } })).status,
    ).toBe(401);
  });

  it("requires bearer authentication and expires codes after 30 seconds", async () => {
    expect((await app.request("/api/v1/login-code", { method: "POST" })).status).toBe(401);
    expect(
      (
        await app.request("/api/v1/login-code", {
          method: "POST",
          headers: { authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const response = await app.request("/api/v1/login-code", { method: "POST", headers });
    const { code } = LoginCode.parse(await response.json());
    clock.mockReturnValue(1_800_000_030_000);
    expect((await app.request(`/login?code=${code}`)).status).toBe(401);
    expect((await app.request("/login?code=unknown")).status).toBe(401);
    expect((await app.request(`/login?token=${token}`)).status).toBe(302);
  });

  it.each([
    "/.//evil.example",
    "http://localhost//evil.example",
    "/\\evil.example",
    "/safe\\path",
    "//evil.example",
    "https://evil.example",
  ])("rejects unsafe redirect %s", async (next) => {
    const response = await app.request(`/login?token=${token}&next=${encodeURIComponent(next)}`);
    expect(response.headers.get("location")).toBe("/");
  });
});

describe("output responses", () => {
  it.each([
    ["daemon", app, "/api/v1"],
    ["worker", worker, "/cluster/v1"],
  ] as const)(
    "%s serves ordinary and empty files with lengths and refuses escaping links",
    async (_name, handler, prefix) => {
      writeFileSync(join(dirs.output, "file.txt"), "safe 中文");
      writeFileSync(join(dirs.output, "empty.txt"), "");
      writeFileSync(join(home, "private.txt"), "private fixture");
      const link = join(dirs.output, `escape-${_name}`);
      symlinkSync(join(home, "private.txt"), link);
      for (const [name, text] of [
        ["file.txt", "safe 中文"],
        ["empty.txt", ""],
      ]) {
        const response = await handler.request(`${prefix}/runs/fixture/files/${name}`, { headers });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(text ?? "")));
        expect(await response.text()).toBe(text);
      }
      expect(
        (await handler.request(`${prefix}/runs/fixture/files/escape-${_name}`, { headers })).status,
      ).toBe(404);
      const large = join(dirs.output, `head-${_name}`);
      writeFileSync(large, Buffer.alloc(1024 * 1024));
      const head = await handler.request(`${prefix}/runs/fixture/files/head-${_name}`, {
        method: "HEAD",
        headers,
      });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(1024 * 1024));
      expect(await head.text()).toBe("");
      await expect
        .poll(() =>
          readdirSync("/proc/self/fd").some((fd) => {
            try {
              return readlinkSync(`/proc/self/fd/${fd}`) === large;
            } catch {
              return false;
            }
          }),
        )
        .toBe(false);
    },
  );
});

it("redacts running process logs across API pages and withholds incomplete secrets at EOF", async () => {
  const prefix = "visible line\n".repeat(4);
  writeFileSync(dirs.log, prefix + secret + "\n".repeat(secret.length));
  const split = Buffer.byteLength(prefix) + 7;
  const get = async (offset: number, limit: number) =>
    LogChunk.parse(
      await (
        await app.request(`/api/v1/runs/fixture/logs?offset=${offset}&limit=${limit}`, { headers })
      ).json(),
    );
  const first = await get(0, split);
  const second = await get(first.next, 1024);
  expect(first.text + second.text).toBe(`${prefix}[redacted]\n`);
  expect(second.next).toBe(prefix.length + secret.length + 1);
  writeFileSync(dirs.log, prefix + secret.slice(0, 8));
  const partial = await get(0, 1024);
  expect(partial.text).toBe(prefix.slice(0, partial.next));
  const download = await app.request("/api/v1/runs/fixture/log.txt", { headers });
  expect(await download.text()).toBe(prefix.slice(0, partial.next));
  appendFileSync(dirs.log, secret.slice(8) + "\n".repeat(secret.length));
  const rest = await get(partial.next, 1024);
  expect(partial.text + rest.text).toBe(`${prefix}[redacted]\n`);
});

it("serves the log tail from a negative offset and rejects a fractional one", async () => {
  const done = Run.parse({ ...run, id: "done", state: "succeeded", cleanup: "done" });
  const doneDirs = runDirs(paths, done.id);
  mkdirSync(doneDirs.output, { recursive: true });
  writeFileSync(doneDirs.log, "first\nsecond\nthird\n");
  const doneApp = createApp({
    token,
    runs: Object.assign(new EventEmitter(), {
      get: (id: string) => (id === done.id ? done : null),
      dirs: () => doneDirs,
      redactor: () => new Redactor([secret]),
    }) as unknown as RunService,
    paths,
    webDir: null,
    startedAt: done.createdAt,
  } as AppDeps);
  const get = async (offset: string) => {
    const res = await doneApp.request(`/api/v1/runs/done/logs?offset=${offset}&limit=4096`, {
      headers,
    });
    return { status: res.status, body: await res.json() };
  };
  const tail = await get("-6");
  expect(tail.status).toBe(200);
  expect(LogChunk.parse(tail.body)).toMatchObject({ offset: 13, next: 19, text: "third\n" });
  expect(LogChunk.parse((await get("-4096")).body).text).toBe("first\nsecond\nthird\n");
  expect(LogChunk.parse((await get("0")).body).text).toBe("first\nsecond\nthird\n");
  const bad = await get("1.5");
  expect(bad.status).toBe(400);
  expect(bad.body).toMatchObject({ error: expect.stringContaining("safe integer") });
});
